import type { RouteDefaultDomain, RouteDefaults } from "@permitzip/bim-editor/contracts/building-model/route-defaults";
import { notAvailableHere, type Capability } from "../capabilities";
import type { LinkedModelStore, LinkedModelToolsHost, ModelFirmDisciplines, PictureRowsReader, RouteDefaultsStore } from "./capabilities";

/**
 * The models services of a local server: no linked models and no document
 * service to link them from, no AI model to read a picture with (rows given
 * directly still preview and commit), and route defaults held in memory.
 */

/** A linked-model action this server can't do, refused in plain words. */
export class LinkingNotAvailable extends Error {
  constructor(message = "Linking from Autodesk Docs needs a hosted MutinyBIM with an Autodesk connection.") {
    super(message);
    this.name = "LinkingNotAvailable";
  }
}

const notHere = async (): Promise<never> => {
  throw new LinkingNotAvailable();
};

/** Lists no linked models (a local server keeps none); every other action refuses in plain words. */
export const noLinkedModels: LinkedModelStore = {
  async open() {
    return {
      async list() {
        return { canEdit: false, revitModel: null, references: [], autodeskExport: null, docsImports: [] };
      },
      browseDocs: notHere,
      linkFromDocs: notHere,
      update: notHere,
      unlink: notHere,
    };
  },
  refusalMessage(err) {
    return err instanceof LinkingNotAvailable ? err.message : null;
  },
};

/** No open model pins firm disciplines here; a well-formed `firm:` id is checked on its shape. */
export const noModelFirmDisciplines: ModelFirmDisciplines = async () => null;

export const localLinkedModelTools: LinkedModelToolsHost = { store: noLinkedModels, modelFirmDisciplines: noModelFirmDisciplines };

/** A local server has no AI model to read a picture with. */
export const noPictureReader: Capability<PictureRowsReader> = notAvailableHere("Reading a picture needs an AI model; this local server has none.");

/** Route defaults held in memory per person, project and duct or pipe, for as long as the server runs. */
export function memoryRouteDefaults(): { readonly store: RouteDefaultsStore; save(userId: string, projectId: string, domain: RouteDefaultDomain, defaults: RouteDefaults | null): void } {
  const rows = new Map<string, RouteDefaults>();
  const key = (userId: string, projectId: string, domain: RouteDefaultDomain) => `${userId}|${projectId}|${domain}`;
  const userOf = (extra: unknown): string => {
    if (typeof extra !== "object" || extra === null || !("authInfo" in extra)) return "local";
    const auth = extra.authInfo;
    if (typeof auth !== "object" || auth === null || !("extra" in auth)) return "local";
    const fields = auth.extra;
    if (typeof fields !== "object" || fields === null || !("userId" in fields)) return "local";
    return typeof fields.userId === "string" && fields.userId.length > 0 ? fields.userId : "local";
  };
  return {
    store: async (extra, projectId, domain) => rows.get(key(userOf(extra), projectId, domain)) ?? null,
    save(userId, projectId, domain, defaults) {
      if (defaults === null) rows.delete(key(userId, projectId, domain));
      else rows.set(key(userId, projectId, domain), defaults);
    },
  };
}
