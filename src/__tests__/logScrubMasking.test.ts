/**
 * Masking of phone numbers, currency amounts and spelled-out digit runs in
 * scrubText, and the safe form of risky messages in toLogEntry (URL with a
 * query/fragment/userinfo, relative query, form body, brace payload). Pure
 * functions; fictional data only.
 */
import { describe, it, expect } from "@jest/globals";

import { scrubText, toLogEntry } from "../tools/logScrub.js";
import { item } from "./helpers/logFixtures.js";

const scrub = (s: string) => scrubText(s, 500);
const msgOf = (
  msg: unknown,
  options?: { rawMessages?: boolean },
  msgChars?: number,
) => (toLogEntry(item(1, { msg }) as any, msgChars, options) as any).msg;

describe("scrubText masking (A)", () => {
  describe("phone numbers", () => {
    it.each([
      "555-123-4567",
      "(555) 123-4567",
      "555.123.4567",
      "+1 555 123 4567",
      "+44 20 7946 0958",
    ])("masks %p to <phone>", (p) => {
      expect(scrub(p)).toBe("<phone>");
    });

    it("masks a phone number inside a sentence and keeps the rest", () => {
      expect(scrub("call 555-123-4567 now")).toBe("call <phone> now");
    });

    it("masks two numbers independently", () => {
      expect(scrub("a 555-123-4567 b +44 20 7946 0958 c")).toBe(
        "a <phone> b <phone> c",
      );
    });

    it.each([
      "delta +1.5 2.5 3.0",
      "+1 2 3",
      "took 100 200 3000 ms",
      "v2.100.200.3000",
      "call 555 123 4567 now",
    ])("phone negative %p stays unchanged", (s) => {
      expect(scrub(s)).toBe(s);
    });
  });

  describe("currency amounts", () => {
    it.each([
      ["$1,234.56", "<amount>"],
      ["€12", "<amount>"],
      ["£5.00", "<amount>"],
      ["50 USD", "<amount>"],
      ["USD 50", "<amount>"],
      ["1.234,56 EUR", "<amount>"],
      ["20 GBP", "<amount>"],
      ["7 CAD", "<amount>"],
      ["9 AUD", "<amount>"],
    ])("masks %p", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it.each([
      ["12,50€", "<amount>"],
      ["1.234,56 €", "<amount>"],
      ["¥500", "<amount>"],
      ["₹1,200", "<amount>"],
      ["50 usd", "<amount>"],
      ["CHF 20", "<amount>"],
      ["20 jpy", "<amount>"],
      ["30 INR", "<amount>"],
      ["30 SEK", "<amount>"],
      ["30 NOK", "<amount>"],
      ["30 DKK", "<amount>"],
      ["30 NZD", "<amount>"],
      ["30 CNY", "<amount>"],
      ["$10", "<amount>"],
      ["$5.00", "<amount>"],
    ])("masks (extended) %p", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it.each(["replace $1 with $2", "$5"])(
      "a lone single digit after a symbol is a placeholder, unchanged: %p",
      (s) => {
        expect(scrub(s)).toBe(s);
      },
    );

    it("masks an amount inside a sentence and keeps the rest", () => {
      expect(scrub("charged $1,234.56 to the card")).toBe(
        "charged <amount> to the card",
      );
    });
  });

  describe("spelled-out digit runs", () => {
    it.each([
      ["one two three", "<digits>"],
      ["One Two Three", "<digits>"],
      ["four-five-six", "<digits>"],
      ["seven, eight, nine, zero", "<digits>"],
      ["my pin is one two three four ok", "my pin is <digits> ok"],
    ])("collapses %p", (input, expected) => {
      expect(scrub(input)).toBe(expected);
    });

    it.each([
      "one two",
      "one moment please",
      "one of two options",
      "zero tolerance",
    ])("leaves %p unchanged", (s) => {
      expect(scrub(s)).toBe(s);
    });
  });

  describe("negatives stay unchanged", () => {
    it.each([
      "status 404",
      "HTTP 500",
      "version 1.2.3",
      "2026-10-28T10:15:30Z",
      "took 1500 ms",
      "retry 3 times",
    ])("%p", (s) => {
      expect(scrub(s)).toBe(s);
    });
  });
});

describe("scrub cost", () => {
  it.each([["1,"], ["1.1.1."]])(
    "scrubText over 10000 repeats of %p is fast and capped",
    (unit) => {
      const started = Date.now();
      const out = scrubText(unit.repeat(10000), 500);
      expect(Date.now() - started).toBeLessThan(500);
      expect(out.length).toBeLessThanOrEqual(500);
    },
  );

  it("scrubText path: toLogEntry over 200000 repeats of '1,' is fast", () => {
    const started = Date.now();
    msgOf("1,".repeat(200000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  describe("hostile 1,000,000-character inputs on the risky path", () => {
    const shapes = [
      "{",
      "a=1&",
      "http://a@ ",
      "?a=",
      '{"a":',
      "http://a/?b=1 ",
    ];
    const big = (unit: string) =>
      unit.repeat(Math.ceil(1_000_000 / unit.length));
    it.each(shapes.flatMap((s) => [[s, 500] as const, [s, 4000] as const]))(
      "shape %p with msgChars %p is fast and capped",
      (unit, cap) => {
        const text = big(unit);
        const started = Date.now();
        const m = msgOf(text, undefined, cap);
        expect(Date.now() - started).toBeLessThan(500);
        expect(typeof m).toBe("string");
        expect(m.length).toBeLessThanOrEqual(cap);
      },
    );
  });
});

describe("amount false positives (N6)", () => {
  it.each(["2026-10-28 EUR", "range 10-20 USD", "id=7 USD", "1 $5 off"])(
    "%p stays unchanged",
    (s) => {
      expect(scrubText(s, 500)).toBe(s);
    },
  );

  it.each([
    ["50 USD", "<amount>"],
    ["1.234,56 EUR", "<amount>"],
    ["12,50€", "<amount>"],
    ["$10", "<amount>"],
    ["$5.00", "<amount>"],
  ])("still masks %p", (input, expected) => {
    expect(scrubText(input, 500)).toBe(expected);
  });
});

describe("toLogEntry safe form (B)", () => {
  const FIXTURE =
    'Error calling https://api.example.test/v1/customers?name=Jane%20Doe&phone=555-123-4567&balance=$1,234.56 failed: {"customer":"Jane Doe","phone":"555-123-4567","amount":"$1,234.56"}';
  const SAFE =
    "Error calling api.example.test/vN/customers failed: <payload:customer,phone,amount>";

  // rawMessages keeps the text but applies the A masking (name stays: names
  // cannot be masked reliably, which is why the safe form is the default).
  const RAW_MASKED =
    'Error calling https://api.example.test/v1/customers?name=Jane%20Doe&phone=<phone>&balance=<amount> failed: {"customer":"Jane Doe","phone":"<phone>","amount":"<amount>"}';

  it("replaces the risky CXone-style message with its safe form", () => {
    const m = msgOf(FIXTURE);
    expect(m).toBe(SAFE);
    expect(m).not.toContain("Jane");
    expect(m).not.toContain("555");
    expect(m).not.toContain("1,234");
  });

  it("rawMessages false behaves like the default", () => {
    expect(msgOf(FIXTURE, { rawMessages: false })).toBe(SAFE);
  });

  it("rawMessages true skips the safe form but keeps the A masking", () => {
    expect(msgOf(FIXTURE, { rawMessages: true })).toBe(RAW_MASKED);
  });

  it("a plain non-risky line is unchanged", () => {
    expect(msgOf("Flow node failed after 3 retries")).toBe(
      "Flow node failed after 3 retries",
    );
  });

  // The risk test runs on the raw message before any cut; it must stay linear
  // on hostile text (log messages can carry end-user input of any length).
  it("a 105k-char run of http:// with no query is handled within 500 ms", () => {
    const started = Date.now();
    const m = msgOf("http://".repeat(15000));
    expect(Date.now() - started).toBeLessThan(500);
    expect(m.length).toBeLessThanOrEqual(500);
  });

  describe("tail leak (N1): text beyond the scanned head never appears", () => {
    const leaks = (m: string, words: string[]) =>
      words.filter((w) => m.includes(w));

    it("a. a long query chain hides the personal data after it", () => {
      const m = msgOf(
        `Error https://api.example.test/p?${"a=b&".repeat(500)}name=Jane%20Doe&phone=555-123-4567 end`,
      );
      expect(leaks(m, ["Jane", "Doe", "555", "end"])).toEqual([]);
    });

    it("b. a long query token then prose: no prose, ends with an ellipsis", () => {
      const m = msgOf(
        `https://h.test/p?${"q".repeat(2100)} Jane Doe lives at 12 Elm Street`,
      );
      expect(leaks(m, ["Jane", "Elm", "Street"])).toEqual([]);
      expect(m.endsWith("…")).toBe(true);
    });

    it("c. a query token running past the head: no tail, ends with an ellipsis", () => {
      const m = msgOf(`x https://h.test/p?${"q".repeat(2100)}&name=Jane%20Doe`);
      expect(leaks(m, ["Jane"])).toEqual([]);
      expect(m.endsWith("…")).toBe(true);
    });

    it("d. many URLs then a customer sentence beyond the head", () => {
      const m = msgOf(
        `${"https://h.test/p?x=1 ".repeat(120)}Customer Jane Doe at https://h.test/p?name=Jane`,
      );
      expect(leaks(m, ["Jane", "Customer"])).toEqual([]);
    });

    it("e. a brace span reaching past the head becomes exactly <payload>", () => {
      expect(
        msgOf(`{${"z".repeat(2500)}} after Jane Doe call 555-123-4567`),
      ).toBe("<payload>");
    });

    it("g. a JSON span that closes past the head never yields key names from the tail", () => {
      const m = msgOf(
        `x {"a":1,"pad":"${"y".repeat(2500)}","jane_doe":1} end Jane`,
      );
      expect(m).toBe("x <payload>");
      expect(leaks(m, ["jane_doe", "a,pad", "end", "Jane"])).toEqual([]);
    });

    it("f. a short risky message is reduced exactly as before", () => {
      expect(
        msgOf(
          'Error calling https://api.example.test/v1/customers?name=Jane%20Doe&phone=555-123-4567&balance=$1,234.56 failed: {"customer":"Jane Doe","phone":"555-123-4567","amount":"$1,234.56"}',
        ),
      ).toBe(
        "Error calling api.example.test/vN/customers failed: <payload:customer,phone,amount>",
      );
    });
  });

  describe("generic schemes (N2)", () => {
    it.each([
      ["postgres://admin:hunter2@db:5432/x", "db:N/x"],
      ["failed mongodb://admin:hunter2@db/x now", "failed db/x now"],
      ["mongodb+srv://u:p@c.test/d?x=1", "c.test/d"],
    ])("%p becomes %p and leaks no credentials", (input, expected) => {
      const m = msgOf(input);
      expect(m).toBe(expected);
      expect(m).not.toContain("hunter2");
      expect(m).not.toContain("admin");
    });

    it("file:///etc/hosts has no query or userinfo: not risky, unchanged", () => {
      expect(msgOf("file:///etc/hosts")).toBe("file:///etc/hosts");
    });
  });

  // A password may hold the characters that normally end the authority; the
  // userinfo still ends at the last "@" of the whitespace-free token.
  describe("credentials containing reserved characters (R1)", () => {
    it.each([
      ["db postgres://admin:p#ss@db.host/app failed", "db db.host/app failed"],
      ["postgres://admin:p?ss@db.host/app", "db.host/app"],
      ["postgres://admin:p/ss@db.host/app failed", "db.host/app failed"],
      ["https://u:p@ss@h.test/x", "h.test/x"],
      ["redis://:p#w@cache.test/0", "cache.test/N"],
    ])("%p becomes %p", (input, expected) => {
      const m = msgOf(input);
      expect(m).toBe(expected);
      for (const secret of ["admin", "ss", "p#", "p?", "p/", ":p"]) {
        expect(m).not.toContain(secret);
      }
    });

    it("an email in the query after credentials still leaks no credentials", () => {
      // The last "@" wins, so the host is replaced by the email's domain: the
      // trade-off for never leaking a password that contains a reserved character.
      const m = msgOf("https://u:pw@h.test/x?e=a@b.com");
      expect(m).toBe("b.com");
      expect(m).not.toContain("pw");
    });

    it.each([
      ["https://api.test:8080/x?id=1", "api.test:N/x"],
      ["https://bob@host.test/x?e=a@b.com", "host.test/x"],
      ["https://api.test/x?e=a@b.com", "api.test/x"],
    ])("%p is unchanged by the credential rule: %p", (input, expected) => {
      expect(msgOf(input)).toBe(expected);
    });
  });

  // A host followed by a numeric port is not userinfo, so an "@" in the path
  // or query (scoped packages, /@user routes, emails) must not swallow the host.
  describe("host:port with an @ later in the token", () => {
    it.each([
      ["https://example.com:443/@alice?x=1", "example.com:N/@alice"],
      [
        "https://registry.test:443/@scope/pkg?x=1",
        "registry.test:N/@scope/pkg",
      ],
      ["http://localhost:3000/@vite/client?t=1", "localhost:N/@vite/client"],
      ["http://[::1]:8080/@a?x=1", "[::N]:N/@a"],
      ["https://h.test:443/x?e=a@b.com", "h.test:N/x"],
      ["https://bob@host.test:8443/@x?y=1", "host.test:N/@x"],
    ])("%p keeps the host: %p", (input, expected) => {
      expect(msgOf(input)).toBe(expected);
    });

    it.each([
      ["postgres://admin:123#x@db.host/app", "db.host/app"],
      ["postgres://admin:123/x@db.host/app", "db.host/app"],
      ["postgres://svc:9?x@db.host/app", "db.host/app"],
    ])(
      "a numeric-looking password after a non-host user is still stripped: %p",
      (input, expected) => {
        const m = msgOf(input);
        expect(m).toBe(expected);
        expect(m).not.toContain("admin");
        expect(m).not.toContain("svc");
      },
    );

    it("known gap: a dotted username with a numeric password prefix before a reserved character is read as host:port", () => {
      // john.doe:123 looks exactly like host:port, so it cannot be told apart.
      expect(msgOf("postgres://john.doe:123#abc@db.host/app")).toBe(
        "john.doe:N",
      );
    });
  });

  it("the safe form is also applied when the cap is raised", () => {
    expect(msgOf(FIXTURE, undefined, 4000)).toBe(SAFE);
  });

  describe("risk detection", () => {
    it.each([
      [
        "R2 userinfo, no query",
        "at https://u:pw@host.test/x ok",
        "at host.test/x ok",
      ],
      [
        "R3 relative query",
        "GET /v1/customers?name=Jane%20Doe&phone=555-123-4567 failed",
        "GET /vN/customers failed",
      ],
      ["R4 form body", "sent name=Jane&city=Oslo ok", "sent <form> ok"],
      ["R5 brace, no closing", "open { brace only", "open <payload>"],
      ["R5 unclosed JSON", 'oops {"a":"', "oops <payload>"],
    ])("risky: %s", (_l, input, expected) => {
      expect(msgOf(input)).toBe(expected);
    });

    it.each([
      "closing } only",
      "plain text with no tokens",
      "retry a=b ok",
      "GET https://api.example.test/v1/customers ok",
    ])("not risky, unchanged: %p", (s) => {
      expect(msgOf(s)).toBe(s);
    });
  });

  describe("URL safe form", () => {
    it.each([
      ["https://user:pw@host.test/x?y=1", "host.test/x"],
      ["ftp://f.test/a/b?c=1", "f.test/a/b"],
      ["wss://w.test/s?t=1#h", "w.test/s"],
      ["https://admin:hunter@db.test/db", "db.test/db"],
      [
        "https://docs.example.test/guide/intro#setup",
        "docs.example.test/guide/intro",
      ],
    ])("%p becomes %p", (url, expected) => {
      expect(msgOf(`see ${url} now`)).toBe(`see ${expected} now`);
    });
  });

  describe("payload safe form", () => {
    it.each([
      ['{"error":"timeout"}', "<payload:error>"],
      ['{"error":"auth failed","code":401}', "<payload:error,code>"],
      ['{"zeta":1,"alpha":2}', "<payload:zeta,alpha>"],
      ['{"a":1,"b":"x"}', "<payload:a,b>"],
      ["{}", "<payload>"],
      ['{"a":1,"b":1,"c":1,"d":1,"e":1,"f":1,"g":1,"h":1,"i":1}', "<payload>"],
      ['{"a b":1}', "<payload>"],
      ['{"1a":1}', "<payload>"],
      ['{"Jane":1}', "<payload>"],
      ['{"john-smith":{"x":1}}', "<payload>"],
      ['{"user.name":1}', "<payload>"],
      ['{"customerId":1,"first_name":"x"}', "<payload:customerId,first_name>"],
      ["{not json}", "<payload>"],
    ])("%s becomes %s", (span, expected) => {
      expect(msgOf(`x ${span} y`)).toBe(`x ${expected} y`);
    });

    it("eight valid keys keep their names", () => {
      expect(
        msgOf('x {"a":1,"b":1,"c":1,"d":1,"e":1,"f":1,"g":1,"h":1} y'),
      ).toBe("x <payload:a,b,c,d,e,f,g,h> y");
    });

    it("values are never kept", () => {
      expect(msgOf('x {"error":"Jane Doe"} y')).toBe("x <payload:error> y");
    });

    it("a span that is not valid JSON becomes <payload>", () => {
      expect(msgOf('x {"a":{"b":1}} y {"c":2} z')).toBe("x <payload> z");
    });

    it("a span longer than 100000 characters becomes <payload> quickly", () => {
      const started = Date.now();
      const m = msgOf(`x {"a":"${"y".repeat(100001)}"} z`);
      expect(Date.now() - started).toBeLessThan(500);
      // The closing brace lies past the scanned head, so the text after it is
      // dropped, never copied raw (see "tail leak (N1)").
      expect(m).toBe("x <payload>");
    });
  });

  describe("risky cap and raw mode limits", () => {
    // truncate keeps maxChars - 1 characters and an ellipsis: exactly maxChars.
    it("a risky message is capped at exactly 200 characters when msgChars is higher", () => {
      const m = msgOf(`${"word ".repeat(100)} {"a":1}`, undefined, 4000);
      expect(m).toHaveLength(200);
      expect(m.endsWith("…")).toBe(true);
    });

    it("a risky message is capped at exactly msgChars when that is lower than 200", () => {
      const m = msgOf(`${"word ".repeat(100)} {"a":1}`, undefined, 100);
      expect(m).toHaveLength(100);
      expect(m.endsWith("…")).toBe(true);
    });

    it("rawMessages true with msgChars 4000 returns a 3000-character text uncut", () => {
      const text = `${"abcd ".repeat(600).slice(0, 2999)}e`;
      expect(msgOf(text, { rawMessages: true }, 4000)).toBe(text);
    });

    it.each([123, { a: 1 }, null])(
      "a non-string msg %p with rawMessages true yields an empty string",
      (v) => {
        expect(msgOf(v, { rawMessages: true })).toBe("");
      },
    );
  });
});
