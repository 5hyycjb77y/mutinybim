import type { ConnectorEndTypeItem } from "@permitzip/bim-kernel";

/**
 * Pipe end types (round 9 J9): the joints a pipe fitting or a part's pipe
 * connection is made with. `stored` reads the `joint` a pipe fitting has
 * always kept, so every routed fitting already carries its end type. Each
 * joins its own kind; the pairs below join only through the adapter named.
 */
const pipe = (name: string, label: string, joinsVia: ConnectorEndTypeItem["joinsVia"] = []): ConnectorEndTypeItem => ({
  id: `plumbing_gas.${name}`,
  label,
  domains: ["pipe"],
  stored: { param: "joint", values: [name] },
  ...(joinsVia && joinsVia.length > 0 ? { joinsVia } : {}),
});

const toThread = (fitting: string) => [{ endType: "plumbing_gas.threaded", fitting }];

export const PIPE_END_TYPES: readonly ConnectorEndTypeItem[] = [
  pipe("threaded", "Threaded (NPT)"),
  pipe("sweat", "Sweat (soldered)", toThread("sweat-to-thread adapter")),
  pipe("press", "Press", toThread("press-to-thread adapter")),
  pipe("no_hub", "No-hub coupling", [{ endType: "plumbing_gas.hub_gasket", fitting: "no-hub to hub adapter" }]),
  pipe("hub_gasket", "Hub and spigot, compression gasket"),
  pipe("solvent_weld", "Solvent weld", toThread("threaded adapter")),
  pipe("pex_crimp", "PEX crimp ring", toThread("PEX-to-thread adapter")),
  pipe("pex_expansion", "PEX expansion", toThread("PEX-to-thread adapter")),
  pipe("fusion", "Socket fusion", toThread("transition fitting")),
  pipe("csst_mechanical", "CSST mechanical fitting", toThread("CSST termination fitting")),
];
