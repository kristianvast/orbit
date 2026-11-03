import { describe, expect, test } from "bun:test";
import { ConnectorParseError, parseCsv, parseXmlRecords } from "../src";

describe("parseCsv", () => {
  test("handles quotes, embedded delimiters and newlines, CRLF and BOM", () => {
    const t = parseCsv('\uFEFFa,b\r\n"x, y","line1\nline2"\r\n\r\n"say ""hi""",z\r\n');
    expect(t.headers).toEqual(["a", "b"]);
    expect(t.rows).toEqual([
      { a: "x, y", b: "line1\nline2" },
      { a: 'say "hi"', b: "z" },
    ]);
  });

  test("auto-detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2").rows).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([{ a: "1", b: "2" }]);
  });

  test("an explicit delimiter wins over detection", () => {
    expect(parseCsv("a|b,c\n1|2,3", { delimiter: "|" }).headers).toEqual(["a", "b,c"]);
  });

  test("pads short rows and rejects empty or unterminated input", () => {
    expect(parseCsv("a,b\n1").rows).toEqual([{ a: "1", b: "" }]);
    expect(() => parseCsv("")).toThrow(ConnectorParseError);
    expect(() => parseCsv('a\n"open')).toThrow(ConnectorParseError);
  });
});

describe("parseXmlRecords", () => {
  test("merges attributes and child elements and decodes entities", () => {
    const t = parseXmlRecords(
      '<r><m id="1" n="A &amp; B"><v>2.5</v></m><m id="2" v="3"/></r>',
      "m",
    );
    expect(t.rows).toEqual([
      { id: "1", n: "A & B", v: "2.5" },
      { id: "2", n: "", v: "3" },
    ]);
  });

  test("throws when no record element exists", () => {
    expect(() => parseXmlRecords("<r/>", "m")).toThrow(ConnectorParseError);
  });
});
