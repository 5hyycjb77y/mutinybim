/**
 * Round 5b f-equipment (decision 3): a library editor adds a firm column in
 * Settings › MutinyBIM library › Shared fields › New field. "Hood ID" is
 * published as a part parameter on equipment and fixtures, so it shows in
 * the equipment list, the Inspector and tags with no code change. A person
 * who can't publish sees New field off, with the reason.
 *
 * Fails on the round-5a code: the browser had no New field.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LibraryBrowser, newFieldItem, type FieldLibraryItem, type LibraryProviderPort, type PublishResult } from "../src";

function provider(canPublish: boolean, publish: jest.Mock<Promise<PublishResult>, [string, FieldLibraryItem, number]>): LibraryProviderPort {
  return {
    scopes: async () => [{ id: "firm", kind: "firm", name: "PermitZIP" }],
    list: async () => [],
    capabilities: async () => (canPublish ? { read: true, publish: true } : { read: true, publish: false, reason: "Publishing needs the firm library write permission." }),
    publish: (scope, item, base) => (item.type === "field" ? publish(scope, item, base) : Promise.resolve({ ok: false, code: "invalid", message: "not a field" })),
  };
}

describe("r5e New field in the library browser", () => {
  it("a library editor adds Hood ID to the firm library as an equipment parameter in its Kitchen section", async () => {
    const publish = jest.fn<Promise<PublishResult>, [string, FieldLibraryItem, number]>(async () => ({ ok: true, summary: { id: "firm:field:hood_id", type: "field", key: "param.hood_id", name: "Hood ID", revision: 1, contentHash: "sha256:x", scope: "firm", deprecated: false } }));
    render(<LibraryBrowser provider={provider(true, publish)} types={["field"]} />);
    const add = await screen.findByTestId("library-add-field");
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hood ID" } });
    fireEvent.change(screen.getByLabelText("Section"), { target: { value: "Kitchen" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to PermitZIP" }));
    await waitFor(() => expect(publish).toHaveBeenCalled());
    const [scope, item, base] = publish.mock.calls[0] ?? [];
    expect([scope, base]).toEqual(["firm", 0]);
    expect(item?.body).toMatchObject({ id: "firm:field:hood_id", key: "param.hood_id", label: "Hood ID", group: "Kitchen", valueType: "text", appliesTo: ["mep.equipment", "mep.plumbing_fixture"], storage: { kind: "parameter", scope: "instance", name: "hood_id" } });
    await waitFor(() => expect(screen.queryByTestId("library-new-field")).toBeNull());
  });

  it("New field is off, with the reason, for a person who can't publish", async () => {
    render(<LibraryBrowser provider={provider(false, jest.fn())} types={["field"]} />);
    const add = await screen.findByTestId("library-add-field");
    await waitFor(() => expect(add).toBeDisabled());
    expect(add).toHaveAttribute("title", "Publishing needs the firm library write permission.");
  });

  it("a number field names its unit; no name or no unit is refused in plain words", () => {
    expect(newFieldItem("firm", { label: "Exhaust", group: "", holds: "number", unit: "cfm" })).toMatchObject({ item: { body: { key: "param.exhaust", valueType: "quantity", kind: "flow_air", unit: "cfm" } } });
    expect(newFieldItem("firm", { label: " ", group: "", holds: "text", unit: "" })).toEqual({ refused: "Give the field a name (Hood ID)." });
    expect(newFieldItem("firm", { label: "Exhaust", group: "", holds: "number", unit: "" })).toEqual({ refused: "Choose the unit the number is in." });
  });
});
