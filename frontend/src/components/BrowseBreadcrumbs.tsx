import { Link } from "react-router";
import { SITE_ORIGIN } from "../lib/pageMeta";
import { JsonLdScript } from "./JsonLdScript";

export type Crumb = { path: string; label: string };

/**
 * The "Browse › Kentucky › Simpson County" trail on the browse-catalog
 * pages: a visible link back up each level, plus the same trail as
 * schema.org BreadcrumbList so a search result can show the path instead
 * of a bare URL. The last crumb is the current page and is not a link.
 */
export function BrowseBreadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <>
      <JsonLdScript
        data={{
          "@type": "BreadcrumbList",
          itemListElement: crumbs.map((crumb, index) => ({
            "@type": "ListItem",
            position: index + 1,
            name: crumb.label,
            item: `${SITE_ORIGIN}${crumb.path}`,
          })),
        }}
      />
      <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <li key={crumb.path} className="flex items-center gap-x-1.5">
                {index > 0 ? <span aria-hidden="true">›</span> : null}
                {last ? (
                  <span aria-current="page">{crumb.label}</span>
                ) : (
                  <Link to={crumb.path} className="underline hover:text-ink">
                    {crumb.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
