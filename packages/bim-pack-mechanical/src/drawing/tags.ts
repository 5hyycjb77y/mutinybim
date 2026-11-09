import { profileLabel, type ElementKindItem, type KindTagTextFace } from "@permitzip/bim-kernel";

/** What a size tag prints for a duct by default (`tagText` on its row): its size in inches ("24"x12"", "10"Ø"). */
const ductSize: KindTagTextFace = (el) => (el.kind === "duct_segment" ? profileLabel(el.profile) : null);

export const MECHANICAL_TAG_TEXT: Readonly<Record<"duct_segment", Pick<ElementKindItem, "tagText">>> = {
  duct_segment: { tagText: ductSize },
};
