/**
 * @jest-environment node
 *
 * Round 8: clients and model servers of this release advertise
 * `organization:setup`, so an add-on switch or a pinned firm discipline is
 * written between them. Fails on round 7's lists: neither advertised it, so
 * every switch was refused with the "older server" words.
 */
import { ORGANIZATION_SETUP_FEATURE } from "@permitzip/bim-kernel";
import { CLIENT_FEATURES, PROTOCOL_FEATURES, SERVER_FEATURES, clientProtocol, peerHas, serverProtocol } from "../src/protocol-version";

describe("x8-protocol-setup", () => {
  it("both sides of this release advertise organization setup", () => {
    expect(PROTOCOL_FEATURES.organizationSetup).toBe(ORGANIZATION_SETUP_FEATURE);
    expect(CLIENT_FEATURES).toContain(ORGANIZATION_SETUP_FEATURE);
    expect(SERVER_FEATURES).toContain(ORGANIZATION_SETUP_FEATURE);
    expect(peerHas(serverProtocol(), ORGANIZATION_SETUP_FEATURE)).toBe(true);
    expect(peerHas(clientProtocol(), ORGANIZATION_SETUP_FEATURE)).toBe(true);
  });
});
