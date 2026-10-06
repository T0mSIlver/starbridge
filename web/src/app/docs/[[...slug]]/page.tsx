import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsPage } from "@/components/Docs";
import { DOCS, renderDoc } from "@/lib/docs";

// Only these docs exist; any other path under /docs is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug ? [d.slug] : [] }));
}

const find = (slug: string[] | undefined) => DOCS.find((d) => d.slug === (slug ?? []).join("/"));

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = find((await params).slug);
  return { title: doc ? `Docs · ${doc.title}` : "Docs" };
}

export default async function Doc({ params }: Props) {
  const doc = find((await params).slug);
  if (!doc) notFound();
  return <DocsPage doc={doc} html={renderDoc(doc)} />;
}
