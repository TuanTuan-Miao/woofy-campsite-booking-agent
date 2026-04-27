import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

type SiteStatus = "available" | "unavailable" | "not_yet_released";

type SiteDefinition = {
  id: string;
  name: string;
  siteNumber: string;
  price: number;
  statusByDate: Record<string, SiteStatus>;
};

type ServerState = {
  reservations: Array<{
    siteId: string;
    reference: string;
    commitMode: "cart" | "payment";
    email: string;
  }>;
};

const parseCookies = (request: IncomingMessage): Record<string, string> => {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return {};
  }

  return Object.fromEntries(
    cookieHeader.split(";").map((item) => {
      const [rawKey, ...rest] = item.trim().split("=");
      return [rawKey, rest.join("=")];
    }),
  );
};

const parseFormBody = async (request: IncomingMessage): Promise<Record<string, string>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(body).entries());
};

const sendHtml = (response: ServerResponse, html: string, statusCode = 200, headers?: Record<string, string>) => {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(html);
};

const renderSitePage = (site: SiteDefinition, date: string | undefined, loggedIn: boolean): string => {
  const normalizedDate = date ?? "";
  const status = site.statusByDate[normalizedDate];
  const isAvailable = status === "available";
  const notYetReleased = status === "not_yet_released";

  return `<!doctype html>
  <html>
    <body>
      <main>
        <h1 data-testid="campsite-name">${site.name}</h1>
        <form method="get">
          <label>
            Arrival Date
            <input data-testid="arrival-date" name="arrival" value="${normalizedDate}" />
          </label>
          <label>
            Nights
            <input data-testid="nights" name="nights" value="2" />
          </label>
          <button data-testid="check-availability" type="submit">Check Availability</button>
        </form>
        ${
          normalizedDate
            ? `<section>
                <p>Total Price: $${site.price.toFixed(2)}</p>
                ${
                  isAvailable
                    ? `<p>Available</p>
                       ${
                         loggedIn
                           ? `<form method="post" action="/camping/campsites/${site.id}/reserve">
                                <input type="hidden" name="commitMode" value="payment" />
                                <button data-testid="book-now" type="submit">Book Now</button>
                              </form>`
                           : `<p>Log in to reserve.</p>`
                       }`
                    : notYetReleased
                      ? `<p>Not Yet Released</p>`
                      : `<p>Not Available</p>`
                }
              </section>`
            : ""
        }
      </main>
    </body>
  </html>`;
};

export const startMockRecreationServer = async () => {
  const sites: SiteDefinition[] = [
    {
      id: "primary-site",
      name: "Pine View 12",
      siteNumber: "12",
      price: 48,
      statusByDate: {
        "07/17/2026": "unavailable",
        "07/18/2026": "unavailable",
      },
    },
    {
      id: "fallback-site",
      name: "River Bend 03",
      siteNumber: "03",
      price: 42,
      statusByDate: {
        "07/17/2026": "available",
        "07/18/2026": "available",
      },
    },
  ];

  const state: ServerState = {
    reservations: [],
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const cookies = parseCookies(request);
    const loggedIn = cookies.session === "mock-session";

    if (request.method === "GET" && url.pathname === "/log-in") {
      sendHtml(
        response,
        `<!doctype html>
        <html>
          <body>
            <form method="post" action="/log-in">
              <label>
                Email
                <input data-testid="email" type="email" name="email" />
              </label>
              <label>
                Password
                <input data-testid="password" type="password" name="password" />
              </label>
              <button data-testid="login-submit" type="submit">Log In</button>
            </form>
          </body>
        </html>`,
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/log-in") {
      sendHtml(
        response,
        "<html><body><p>Logged in.</p></body></html>",
        200,
        {
          "Set-Cookie": "session=mock-session; Path=/",
        },
      );
      return;
    }

    const campgroundMatch = url.pathname.match(/^\/api\/camps\/campgrounds\/([^/]+)$/);
    if (request.method === "GET" && campgroundMatch) {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          campground: {
            facility_name: "Mock Campground",
          },
        }),
      );
      return;
    }

    const availabilityMatch = url.pathname.match(/^\/api\/camps\/availability\/campground\/([^/]+)\/month$/);
    if (request.method === "GET" && availabilityMatch) {
      const startDate = url.searchParams.get("start_date");
      const monthPrefix = startDate?.slice(0, 7);

      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          campsites: Object.fromEntries(
            sites.map((site) => {
              const availabilities = Object.fromEntries(
                Object.entries(site.statusByDate)
                  .filter(([date]) => date.endsWith("/2026"))
                  .map(([date, status]) => {
                    const [month, day, year] = date.split("/");
                    const isoDate = `${year}-${month}-${day}T00:00:00Z`;
                    if (!monthPrefix || isoDate.startsWith(monthPrefix)) {
                      return [
                        isoDate,
                        status === "available"
                          ? "Available"
                          : status === "not_yet_released"
                            ? "Not Reservable"
                            : "Reserved",
                      ];
                    }

                    return undefined;
                  })
                  .filter((entry): entry is [string, string] => Array.isArray(entry)),
              );

              return [
                site.id,
                {
                  availabilities,
                  campsite_id: site.id,
                  campsite_type: "STANDARD NONELECTRIC",
                  site: site.siteNumber,
                },
              ];
            }),
          ),
        }),
      );
      return;
    }

    const siteMatch = url.pathname.match(/^\/camping\/campsites\/([^/]+)$/);
    if (request.method === "GET" && siteMatch) {
      const siteId = siteMatch[1];
      if (!siteId) {
        sendHtml(response, "<html><body>Not found</body></html>", 404);
        return;
      }

      const site = sites.find((item) => item.id === siteId);
      if (!site) {
        sendHtml(response, "<html><body>Not found</body></html>", 404);
        return;
      }

      const arrival = url.searchParams.get("arrival") ?? undefined;
      sendHtml(response, renderSitePage(site, arrival, loggedIn));
      return;
    }

    const reserveMatch = url.pathname.match(/^\/camping\/campsites\/([^/]+)\/reserve$/);
    if (request.method === "POST" && reserveMatch) {
      const siteId = reserveMatch[1];
      if (!siteId) {
        sendHtml(response, "<html><body>Not found</body></html>", 404);
        return;
      }

      const site = sites.find((item) => item.id === siteId);
      if (!site || !loggedIn) {
        sendHtml(response, "<html><body>Unauthorized</body></html>", 401);
        return;
      }

      const body = await parseFormBody(request);
      const commitMode = body.commitMode === "payment" ? "payment" : "cart";
      const reference = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
      state.reservations.push({
        siteId,
        reference,
        commitMode,
        email: "camper@example.com",
      });

      sendHtml(
        response,
        `<!doctype html>
        <html>
          <body>
            <h1 data-testid="campsite-name">${site.name}</h1>
            <input type="checkbox" />
            <form method="get" action="${commitMode === "payment" ? "/checkout/payment" : "/checkout/cart"}">
              <button data-testid="${
                commitMode === "payment" ? "continue-to-payment" : "continue-to-cart"
              }">${commitMode === "payment" ? "Continue to Payment" : "Continue to Cart"}</button>
            </form>
            <p>Reservation Reference: ${reference}</p>
          </body>
        </html>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/checkout/payment") {
      sendHtml(
        response,
        `<!doctype html>
        <html>
          <body>
            <h1 data-testid="campsite-name">River Bend 03</h1>
            <h1>Payment Information</h1>
            <p>Enter payment to complete the booking.</p>
          </body>
        </html>`,
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/checkout/cart") {
      sendHtml(
        response,
        `<!doctype html>
        <html>
          <body>
            <h1>Cart</h1>
            <p>Your reservation is in the cart.</p>
          </body>
        </html>`,
      );
      return;
    }

    sendHtml(response, "<html><body>Not found</body></html>", 404);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the mock server.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
};
