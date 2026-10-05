import { notFound } from "next/navigation";
import { SignIn } from "@/components/Gate";
import { SampleProvider } from "@/components/SampleProvider";

// The sign-in screen alone, for comparing screenshots in development only.
export default function SampleSignIn() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SampleProvider>
      <SignIn />
    </SampleProvider>
  );
}
