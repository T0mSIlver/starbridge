"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

let asked: Promise<string[] | undefined> | undefined;

/**
 * The sign-in methods this server offers (#670). GitHub until the server says otherwise, so the
 * landing page's HTML keeps its buttons; a server that cannot be asked keeps them too. Apple's
 * web sign-in only once the server lists it (#1411).
 */
export function useSignInMethods(): { github: boolean; apple: boolean } {
  const [methods, setMethods] = useState({ github: true, apple: false });
  useEffect(() => {
    asked ??= api.signInMethods().catch(() => undefined);
    let live = true;
    asked.then(
      (m) => live && m && setMethods({ github: m.includes("github"), apple: m.includes("apple") }),
    );
    return () => {
      live = false;
    };
  }, []);
  return methods;
}
