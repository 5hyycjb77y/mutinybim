/**
 * @jest-environment node
 *
 * Round 8b lane A: the canonical bytes and SHA-256 shared by signature
 * envelopes and the sign-off chain. RFC 8785 member order (UTF-16 code
 * units) and number forms, FIPS 180-4 test vectors, and refusals for values
 * JSON can't carry exactly. Fails on round 8's code: there is no authorship
 * module.
 */
import { createHash } from "node:crypto";
import { CanonicalJsonError, canonicalize, parseDigest, payloadDigest, sha256HexOf, utf8Bytes } from "@permitzip/bim-kernel";

describe("a8b-canonical-digest", () => {
  it("sorts members by UTF-16 code units and writes no whitespace", () => {
    // RFC 8785 §3.2.3: "\r" < "1" < "\u0080" < "\u00f6" < "\u20ac" < "\ud83d\ude00" < "\ufb33".
    const value = { "\u20ac": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\ud83d\ude00": "Emoji: Grinning Face", "\u0080": "Control", "\u00f6": "Latin Small Letter O With Diaeresis" };
    const keys = Object.keys(JSON.parse(canonicalize(value)) as Record<string, string>);
    expect(canonicalize(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
    expect(keys).toHaveLength(7);
    expect(canonicalize({ b: [1, { d: true, c: null }], a: "x" })).toBe('{"a":"x","b":[1,{"c":null,"d":true}]}');
  });

  it("writes numbers in ECMAScript form", () => {
    expect(canonicalize([1e21, 1e-7, -0, 0.000001, 333333333.3333333, 4.5, 2e-3, 1e23])).toBe("[1e+21,1e-7,0,0.000001,333333333.3333333,4.5,0.002,1e+23]");
  });

  it("leaves out undefined members and refuses what JSON can't carry exactly", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalize({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(/finite numbers only/);
    expect(() => canonicalize([undefined])).toThrow(/undefined/);
    expect(() => canonicalize({ at: new Date(0) })).toThrow(/ISO string/);
    expect(() => canonicalize({ s: "\ud800" })).toThrow(/lone surrogate/);
    expect(() => canonicalize({ n: BigInt(1) })).toThrow(CanonicalJsonError);
  });

  it("hashes like FIPS 180-4 and like Node", () => {
    expect(sha256HexOf("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256HexOf("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256HexOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    for (const text of ["pzsig/v1", "é€😀".repeat(40), "x".repeat(1000)]) expect(sha256HexOf(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("names a payload as sha256:<hex> and parses any <alg>:<hex>", () => {
    const bytes = utf8Bytes(canonicalize({ decided: "approve", part: "mechanical" }));
    const d = payloadDigest(bytes);
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parseDigest(d)).toEqual({ alg: "sha256", hex: d.slice(7) });
    expect(parseDigest("sha384:" + "a".repeat(96))?.alg).toBe("sha384");
    expect(parseDigest("not a digest")).toBeNull();
  });
});
