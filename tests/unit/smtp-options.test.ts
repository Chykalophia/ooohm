import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { after, before, describe, test } from "node:test";
import nodemailer from "nodemailer";
import { smtpTransportOptions } from "@/lib/mail/smtp-options";

/** An SMTP server that never offers STARTTLS (as if an attacker stripped it) and records every command. */
function strippedServer(): Promise<{ server: Server; port: number; commands: string[] }> {
  const commands: string[] = [];
  const server = createServer((socket) => {
    socket.write("220 mx.test ESMTP\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        if (/^EHLO/i.test(line)) socket.write("250-mx.test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (/^STARTTLS/i.test(line)) socket.write("502 not offered\r\n");
        else if (/^AUTH/i.test(line)) socket.write("235 ok\r\n");
        else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, commands })));
}

describe("SMTP transport security", () => {
  let fake: Awaited<ReturnType<typeof strippedServer>>;
  before(async () => {
    fake = await strippedServer();
  });
  after(() => fake.server.close());

  const send = (requireTls: boolean) =>
    nodemailer
      .createTransport({
        ...smtpTransportOptions({ host: "127.0.0.1", port: fake.port, secure: false, requireTls, user: "apikey", password: "s3cret-password" }),
        connectionTimeout: 2000,
        greetingTimeout: 2000,
      })
      .sendMail({ from: "a@example.com", to: "b@example.com", subject: "Sign in", text: "https://ooohm.team/verify?token=abc" });

  test("with STARTTLS required, a server that does not offer it never sees the password or the message", async () => {
    fake.commands.length = 0;
    await assert.rejects(send(true));
    assert.equal(fake.commands.some((c) => /^AUTH/i.test(c) || /^MAIL/i.test(c) || c.includes("token=abc")), false, fake.commands.join(" | "));
  });

  test("without it (Mailpit in development), the same server gets the login in clear text", async () => {
    fake.commands.length = 0;
    await send(false).catch(() => {});
    assert.ok(fake.commands.some((c) => /^AUTH/i.test(c)), fake.commands.join(" | "));
  });

  test("implicit TLS needs no STARTTLS requirement", () => {
    assert.equal(smtpTransportOptions({ host: "h", port: 465, secure: true, requireTls: true }).requireTLS, false);
    assert.equal(smtpTransportOptions({ host: "h", port: 587, secure: false, requireTls: true }).requireTLS, true);
  });
});
