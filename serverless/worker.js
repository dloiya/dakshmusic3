async function driveToken(env) {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REFRESH_TOKEN
  ) {
    throw new Error("Google Drive credentials are not configured");
  }

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();

    let errorDetails;

    try {
      errorDetails = JSON.parse(errorBody);
    } catch {
      errorDetails = {
        raw: errorBody,
      };
    }

    // Never log client_secret or refresh_token.
    console.error(
      "Google token refresh failed:",
      JSON.stringify({
        status: response.status,
        error: errorDetails.error || null,
        error_description:
          errorDetails.error_description || null,
      })
    );

    throw new Error(
      `Google token refresh failed: ${response.status}`
    );
  }

  const tokenData = await response.json();

  if (!tokenData.access_token) {
    console.error(
      "Google OAuth response did not contain access_token"
    );

    throw new Error(
      "Google OAuth response missing access_token"
    );
  }

  return tokenData.access_token;
}
