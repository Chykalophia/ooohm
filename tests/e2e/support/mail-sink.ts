/**
 * A minimal SMTP server on 127.0.0.1 for the end-to-end journeys: the app sends its real
 * mail (sign-in links, invites, decisions) here over plain SMTP, as it would to Mailpit,
 * and the journeys read the links out of it. No STARTTLS or AUTH is offered, so the app
 * must run with SMTP_REQUIRE_TLS=false. Nothing in the app knows it is being tested.
 */
import { createServer, type Server, type Socket } from "node:net";

export interface Mail {
  to: string[];
  /** The message as sent: headers and body, transfer encoding undone where it is quoted-printable. */
  raw: string;
  subject: string;
}

/** Undoes quoted-printable soft breaks and escapes, enough to read URLs out of a body. */
function decodeQuotedPrintable(text: string): string {
  return text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export class MailSink {
  readonly mails: Mail[] = [];
  private server: Server | undefined;
  private waiters: (() => void)[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** The first mail to `to` (after `since` mails) matching `test`, waiting up to `timeoutMs`. */
  async waitFor(to: string, options: { since?: number; match?: RegExp; timeoutMs?: number } = {}): Promise<Mail> {
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    for (;;) {
      const found = this.mails
        .slice(options.since ?? 0)
        .find((m) => m.to.includes(to.toLowerCase()) && (!options.match || options.match.test(m.raw)));
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`No mail to ${to}${options.match ? ` matching ${options.match}` : ""}. Got: ${this.mails.map((m) => `${m.to} "${m.subject}"`).join("; ")}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => (clearTimeout(timer), resolve()));
      });
    }
  }

  /** The first link in `mail` whose path starts with `path`. */
  static link(mail: Mail, path: string): string {
    const match = new RegExp(`https?://[^\\s"'<>]+${path.replace(/[/.?]/g, "\\$&")}[^\\s"'<>]*`).exec(mail.raw);
    if (!match) throw new Error(`No ${path} link in "${mail.subject}"`);
    return match[0].replaceAll("&amp;", "&");
  }

  private session(socket: Socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    let data: string[] | null = null;
    let to: string[] = [];
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 ooohm-e2e ESMTP");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            const raw = decodeQuotedPrintable(data.join("\r\n"));
            const subject = /^Subject: (.*)$/im.exec(raw)?.[1] ?? "";
            this.mails.push({ to, raw, subject });
            for (const wake of this.waiters.splice(0)) wake();
            data = null;
            to = [];
            reply("250 OK");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") reply("250 ooohm-e2e");
        else if (verb === "MAIL") reply("250 OK");
        else if (verb === "RCPT") {
          const address = /<([^>]+)>/.exec(line)?.[1];
          if (address) to.push(address.toLowerCase());
          reply("250 OK");
        } else if (verb === "DATA") {
          data = [];
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else if (verb === "RSET") {
          to = [];
          reply("250 OK");
        } else reply("250 OK");
      }
    });
    socket.on("error", () => {});
  }
}
