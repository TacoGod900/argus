// Multi-page sample app for crawl tests: a small linked site with a login wall and
// deliberately planted bugs (a console error, a broken image). Cookie-based session.
import { createServer } from "node:http";

const port = process.env.PORT ?? 4610;
const SESSION = "argus-sess=ok";

const html = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const nav = `<nav>
  <a href="/">Home</a>
  <a href="/catalog">Catalog</a>
  <a href="/about">About</a>
  <a href="/account">Account</a>
  <a href="/logout">Log out</a>
</nav>`;

function isAuthed(req) {
  return (req.headers.cookie ?? "").includes(SESSION);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  // Login form submit.
  if (path === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (params.get("email") === "demo@example.com" && params.get("password") === "hunter2") {
        res.writeHead(302, { "set-cookie": SESSION + "; Path=/", location: "/account" });
        res.end();
      } else {
        res.writeHead(401, { "content-type": "text/html" });
        res.end(html("Login", `${nav}<h1>Login</h1><p id="err">Invalid credentials</p>`));
      }
    });
    return;
  }

  const send = (status, title, body) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(html(title, body));
  };

  switch (true) {
    case path === "/":
      return send(200, "Home", `${nav}<h1>Welcome</h1><p>Streaming-ish demo app.</p>`);

    case path === "/catalog":
      // Planted bug: a broken image (bad src).
      return send(
        200,
        "Catalog",
        `${nav}<h1>Catalog</h1>
         <img src="/img/does-not-exist.png" alt="hero" width="200" height="100" />
         <ul>
           <li><a href="/product/1">Product 1</a></li>
           <li><a href="/product/2">Product 2</a></li>
           <li><a href="/product/3">Product 3</a></li>
         </ul>`,
      );

    case path.startsWith("/product/"):
      // Templated pages, identical shape — should be sampled, not all crawled.
      return send(200, "Product", `${nav}<h1>A product</h1><p>Buy this.</p><a href="/catalog">Back</a>`);

    case path === "/about":
      // Planted bug: a console error.
      return send(
        200,
        "About",
        `${nav}<h1>About</h1><script>console.error("planted: about page boom");</script>`,
      );

    case path === "/login":
      return send(
        200,
        "Login",
        `${nav}<h1>Login</h1>
         <form method="POST" action="/login">
           <input name="email" placeholder="Email" />
           <input name="password" type="password" placeholder="Password" />
           <button type="submit">Sign in</button>
         </form>`,
      );

    case path === "/account":
      if (!isAuthed(req)) {
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      return send(200, "Account", `${nav}<h1>Your account</h1><p>Welcome back, demo.</p>`);

    case path === "/logout":
      res.writeHead(302, { "set-cookie": "argus-sess=; Path=/; Max-Age=0", location: "/" });
      res.end();
      return;

    default:
      return send(404, "Not found", `${nav}<h1>404</h1>`);
  }
}).listen(port, () => console.log(`site-server on ${port}`));
