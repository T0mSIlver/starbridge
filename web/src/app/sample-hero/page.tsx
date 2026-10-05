import { notFound } from "next/navigation";
import { Inbox } from "@/components/Inbox";
import { SampleProvider } from "@/components/SampleProvider";
import { Shell } from "@/components/Shell";

// The landing page's browser shot: the sample inbox as SampleProvider's `landing` trims it, in
// development only.
export default function SampleHero() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SampleProvider landing>
      <Shell>
        <Inbox />
      </Shell>
    </SampleProvider>
  );
}
