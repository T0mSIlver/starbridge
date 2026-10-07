"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

let asked: Promise<string[] | undefined> | undefined;

/**
 * Whether this server offers GitHub sign-in (#670). True until the server says otherwise, so the
 * landing page's HTML keeps its buttons; a server that cannot be asked keeps them too.
 */
export function useGitHubSignIn(): boolean {
  const [github, setGitHub] = useState(true);
  useEffect(() => {
    asked ??= api.signInMethods().catch(() => undefined);
    let live = true;
    asked.then((methods) => live && methods && setGitHub(methods.includes("github")));
    return () => {
      live = false;
    };
  }, []);
  return github;
}
