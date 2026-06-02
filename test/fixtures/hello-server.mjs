import { createServer } from "node:http";

const port = process.env.PORT ?? 4599;
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>Hello</title><h1>hello from fixture</h1>");
}).listen(port, () => {
  console.log(`hello-server listening on ${port}`);
});
