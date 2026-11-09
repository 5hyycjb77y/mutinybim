import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";

/** What the editor passes a link: an address plus ordinary anchor attributes. */
export type EditorLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly href: string;
  /** Whether a host that prefetches pages should fetch this one ahead of the click. */
  readonly prefetch?: boolean;
};

/** What the editor gives a host's links for one issued drawing set. */
export interface EditorIssuedSheetLinksProps {
  /** The model the set was issued from. */
  readonly modelRef: string;
  readonly issueId: string;
  /** Offer to withdraw the set: its name, and why the person can't (null when they can). */
  readonly withdraw?: { readonly issueName: string; readonly disabledReason: string | null };
}

/** The host page's header around the editor, when the editor is opened as one of the host's files. */
export interface EditorFileChrome {
  /** Show what is open (a view, a sheet) after the file's name in the host's breadcrumb; null clears it. */
  setTitle(title: string | null): void;
  /** Renders its children (the editor's save and connection status) in the host header's trailing slot. */
  readonly HeaderTrailing: ComponentType<{ readonly children: ReactNode }>;
}

/**
 * The host's frame around the editor: the settings-page layout the editor's
 * settings sections sit in, the header slot the editor's status goes into,
 * links to issued sheets, asset addresses (the PDF worker). Each piece is a
 * component or value the host passes in; a piece the host leaves out is
 * replaced by plain words, never an error.
 */
export interface EditorShellHost {
  /**
   * Each sheet of an issued set with the page its QR code opens and its own
   * PDF. Absent: the editor says in one line that this app keeps no
   * published copies of issued sheets.
   */
  readonly IssuedSheetLinks?: ComponentType<EditorIssuedSheetLinksProps>;
  /** Where a person reads how to connect their own AI to the model. Absent or null: the host has no such page. */
  readonly connectAgentHref?: string | null;
  /** The host's link (client-side navigation within the app). Absent: links are plain anchors. */
  readonly Link?: ComponentType<EditorLinkProps>;
  /**
   * A React hook: the host header the editor sits in, or null where there is
   * none. Absent or null: the editor shows its title and status in its own
   * ribbon.
   */
  readonly useFileChrome?: () => EditorFileChrome | null;
}
