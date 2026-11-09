// Minimal SMTP sink: accepts every message and appends it to mail.log.
import net from "node:net";
import { appendFileSync } from "node:fs";
const LOG = new URL("./mail.log", import.meta.url).pathname;
net
  .createServer((s) => {
    console.log("conn"); let data = false;
    let buf = "";
    let msg = "";
    s.write("220 sink ESMTP\r\n");
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); if (!data) console.log("<", line);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            appendFileSync(LOG, msg + "\n=====END=====\n");
            msg = "";
            s.write("250 OK\r\n");
          } else msg += line + "\n";
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") s.write("250-sink\r\n250 OK\r\n");
        else if (cmd === "HELO") s.write("250 OK\r\n");
        else if (cmd === "DATA") {
          data = true;
          s.write("354 go\r\n");
        } else if (cmd === "STAR") s.write("502 no tls\r\n");
        else if (cmd === "QUIT") {
          s.write("221 bye\r\n");
          s.end();
        } else s.write("250 OK\r\n");
      }
    });
  })
  .listen(2525, "127.0.0.1", () => console.log("smtp sink on 2525"));
