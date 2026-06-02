import { createServer } from "node:http";

const port = process.env.PORT ?? 4601;

const page = `<!doctype html>
<html><head><title>Fixture App</title></head>
<body>
  <h1>Fixture App</h1>
  <input id="email" placeholder="Email" />
  <button id="go">Sign up</button>
  <p id="status">idle</p>
  <script>
    console.error("boot warning: demo console error");
    document.getElementById("go").addEventListener("click", async () => {
      document.getElementById("status").textContent = "clicked";
      try { await fetch("/api/missing"); } catch (e) {}
    });
  </script>
</body></html>`;

createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
}).listen(port, () => console.log(`app-server on ${port}`));
