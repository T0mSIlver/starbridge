import { notFound } from "next/navigation";
import { SampleProvider } from "@/components/SampleProvider";
import { Shell } from "@/components/Shell";

// The app with the mockups' data, for comparing screenshots in development only.
export default function SampleLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SampleProvider>
      <Shell>{children}</Shell>
    </SampleProvider>
  );
}
