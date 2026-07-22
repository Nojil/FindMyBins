// Native deep-link fallback: if the OS routes findmybins://auth-callback
// directly to the app (instead of the auth session returning it), adopt the
// token here.

import React, { useEffect, useRef } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { LoadingView } from "../ui";

export default function NativeAuthCallback() {
  const { refresh } = useSession();
  const { access_token } = useLocalSearchParams<{ access_token?: string }>();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      if (typeof access_token === "string" && access_token) {
        await api.auth.adoptToken(access_token);
        await refresh();
      }
      router.replace("/");
    })();
  }, [access_token, refresh]);

  return <LoadingView />;
}
