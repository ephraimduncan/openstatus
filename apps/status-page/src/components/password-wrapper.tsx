"use client";

import { parseAsString, useQueryState } from "nuqs";
import { useEffect } from "react";

export function PasswordWrapper({ children }: { children?: React.ReactNode }) {
  const [password, setPassword] = useQueryState("pw", parseAsString);

  useEffect(() => {
    if (password) {
      setPassword(null);
    }
  }, [password, setPassword]);

  return children;
}
