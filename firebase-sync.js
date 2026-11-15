window.FirebaseSync = (() => {
  const AUTH_STORAGE_KEY = "grimoire_firebase_auth";

  async function getAuthConfig() {
    const res = await chrome.storage.local.get(AUTH_STORAGE_KEY);
    return res[AUTH_STORAGE_KEY] || null;
  }

  async function saveAuthConfig(auth) {
    await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: auth });
  }

  async function clearAuthConfig() {
    await chrome.storage.local.remove(AUTH_STORAGE_KEY);
  }

  async function authenticate(mode, { projectId, apiKey, email, password }) {
    const endpoint =
      mode === "signup"
        ? `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`
        : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || "Authentication failed");
    }

    const auth = {
      projectId: projectId.trim(),
      apiKey: apiKey.trim(),
      email: data.email,
      uid: data.localId,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000
    };

    await saveAuthConfig(auth);
    return auth;
  }

  async function ensureFreshToken(auth) {
    if (!auth) return null;
    if (Date.now() < (auth.expiresAt || 0) - 120000) {
      return auth;
    }

    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(auth.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`
      }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || "Session expired — please sign in again.");
    }

    const updated = {
      ...auth,
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      uid: data.user_id || auth.uid,
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
    };

    await saveAuthConfig(updated);
    return updated;
  }

  function docUrl(auth) {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      auth.projectId
    )}/databases/(default)/documents/users/${encodeURIComponent(auth.uid)}/grimoire/state`;
  }

  async function pullState() {
    const rawAuth = await getAuthConfig();
    if (!rawAuth) return null;
    const auth = await ensureFreshToken(rawAuth);

    const res = await fetch(docUrl(auth), {
      headers: { Authorization: `Bearer ${auth.idToken}` }
    });

    if (res.status === 404) return null; // First-time sync
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Firestore pull failed (${res.status})`);
    }

    const doc = await res.json();
    const rawPayload = doc?.fields?.payload?.stringValue;
    return rawPayload ? JSON.parse(rawPayload) : null;
  }

  async function pushState(state) {
    const rawAuth = await getAuthConfig();
    if (!rawAuth) return false;
    const auth = await ensureFreshToken(rawAuth);

    const body = {
      fields: {
        payload: { stringValue: JSON.stringify(state) },
        updatedAt: { integerValue: String(state.updatedAt || Date.now()) }
      }
    };

    const res = await fetch(docUrl(auth), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Firestore push failed (${res.status})`);
    }
    return true;
  }

  return {
    getAuthConfig,
    clearAuthConfig,
    authenticate,
    pullState,
    pushState
  };
})();