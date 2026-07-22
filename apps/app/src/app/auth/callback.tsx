// OAuth landing page. Base44 redirects here with ?access_token=… after a
// provider sign-in. Two jobs:
//   • Web flow: the SDK has already captured the token — refresh the session
//     and go home.
//   • Native flow (page opened inside an auth-session browser with
//     ?return_to=<app scheme url>): forward the token to the app so the
//     session closes and the app signs in.

import React, { useEffect, useRef } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useSession } from "../../lib/session";
import { LoadingView } from "../../ui";

export default function AuthCallback() {
  const { refresh } = useSession();
  const params = useLocalSearchParams<{ return_to?: string; access_token?: string }>();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const returnTo = typeof params.return_to === "string" ? params.return_to : null;
      if (returnTo && typeof window !== "undefined") {
        // Token may still be in the URL, or already captured by the SDK.
        let token = typeof params.access_token === "string" ? params.access_token : null;
        if (!token) {
          try { token = window.localStorage?.getItem("base44_access_token") ?? null; } catch { /* ignore */ }
        }
        if (token && /^(findmybins|exp|exps):/.test(returnTo)) {
          const sep = returnTo.includes("?") ? "&" : "?";
          window.location.replace(`${returnTo}${sep}access_token=${encodeURIComponent(token)}`);
          return;
        }
      }
      await refresh();
      router.replace("/");
    })();
  }, [params.return_to, params.access_token, refresh]);

  return <LoadingView />;
}
