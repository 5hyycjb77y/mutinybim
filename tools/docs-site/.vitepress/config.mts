import { readFileSync } from "node:fs";
import { defineConfig } from "vitepress";
import { slug } from "../../docs/slug";

// Written by assemble.ts from the pages it gathers.
const sidebar = JSON.parse(readFileSync(new URL("./sidebar.generated.json", import.meta.url), "utf8"));
const repo = process.env.MUTINYBIM_DOCS_REPO_URL ?? "https://github.com/permitzip/mutinybim";

export default defineConfig({
  title: "MutinyBIM",
  description: "Docs for MutinyBIM, the open, agent-first building model for every trade: guides for people, and a reference generated from the code for people and agents.",
  base: process.env.MUTINYBIM_DOCS_BASE ?? "/",
  srcDir: "./content",
  cleanUrls: true,
  // The README links to the local demo on localhost.
  ignoreDeadLinks: [/^https?:\/\/(localhost|127\.0\.0\.1)\b/],
  lastUpdated: false,
  head: [["link", { rel: "icon", href: "/brand/mutiny-icon.svg" }]],
  markdown: {
    // Raw HTML stays text: the docs show placeholders like <model id> outside code.
    html: false,
    // GitHub's anchors, so a link that works on GitHub works here.
    anchor: { slugify: slug },
  },
  themeConfig: {
    logo: "/brand/mutiny-icon.svg",
    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "Reference", link: "/reference/" },
      { text: "For agents", link: "/llms.txt", target: "_self" },
      { text: "Hosted app", link: "https://app.mutinybim.com" },
    ],
    sidebar,
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repo }],
    outline: { level: [2, 3] },
    footer: { message: "Apache License 2.0. The reference is generated from the code on every change." },
  },
});
