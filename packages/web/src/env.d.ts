declare module "*.svg?react" {
  import type { FunctionComponent, SVGProps } from "react";
  const ReactComponent: FunctionComponent<SVGProps<SVGSVGElement> & { title?: string }>;
  export default ReactComponent;
}

interface ImportMetaEnv {
  // Baked in by rsbuild at build time from PANTHEON_BASE_ORIGIN /
  // PANTHEON_DOMAIN. Used as the base for the external "Browse App Store"
  // link. Guaranteed to be present (build fails otherwise).
  readonly ROME_CLOUD_ORIGIN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// MDX design docs, compiled by @mdx-js/loader (see rsbuild.config.ts). The
// default export is a React component; `components` overrides which element
// each Markdown construct renders as.
declare module "*.mdx" {
  import type { ComponentType, ReactNode } from "react";
  const MDXComponent: ComponentType<{
    components?: Record<string, ComponentType<Record<string, unknown>>>;
    children?: ReactNode;
  }>;
  export default MDXComponent;
}
