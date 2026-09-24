import { apiRequest, purgeAccountScopedQueries } from "@voteapp/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { LabeledInput } from "../../components/LabeledInput";
import { ErrorNotice } from "../../components/Status";
import { clearSessionId } from "../../lib/sessionStore";

/**
 * Port of the web ResetPasswordPage. The token normally arrives via the
 * email link (deep link when the app is installed, via the /reset-password
 * alias route); the pasted-token input stays as a fallback for mail
 * clients that mangle links — unlike the web, which can rely on ?token=
 * always being present.
 */
export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const paramToken = typeof params.token === "string" ? params.token.trim() : "";
  const [token, setToken] = useState(paramToken);
  const [lastParamToken, setLastParamToken] = useState(paramToken);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // A deep link can update the param while this screen stays mounted;
  // sync it into state then — but never clobber a pasted code
  // with an absent param. Render-time adjustment, per React's
  // "adjusting state when a prop changes" pattern.
  if (paramToken && paramToken !== lastParamToken) {
    setLastParamToken(paramToken);
    setToken(paramToken);
  }

  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: () =>
      apiRequest<{ status: string }>("/api/auth/reset-password", {
        method: "POST",
        body: { token: token.trim(), password },
      }),
    onSuccess: async () => {
      // The backend just revoked every session (epoch bump). Drop the local
      // remnants too — the success copy says "logged out everywhere", so a
      // stored (now dead) Bearer id and cached identity must not linger.
      await clearSessionId().catch(() => {});
      queryClient.setQueryData(["me"], null);
      purgeAccountScopedQueries(queryClient);
    },
  });

  // Same rule as the web page and sign-up: a typo here locks the reader out
  // until they request another link, so the password is typed twice. The
  // mismatch hint waits until both fields have input.
  const passwordsMismatch =
    password.length > 0 && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit =
    token.trim().length > 0 &&
    password.length > 0 &&
    password === confirmPassword &&
    !reset.isPending;

  if (reset.isSuccess) {
    return (
      <ScrollView className="flex-1 bg-white" contentContainerClassName="px-4 py-10">
        <Stack.Screen options={{ title: "Password updated" }} />
        <Text className="text-2xl font-bold text-ink">Password updated</Text>
        <Text className="mt-3 text-ink-soft">
          Your password has been changed and you have been logged out everywhere. Log in with the new
          password.
        </Text>
        <Pressable
          onPress={() => router.replace("/auth/login")}
          accessibilityRole="link"
          className="mt-6 self-start rounded-lg bg-rausch px-4 py-2 active:bg-rausch-dark"
        >
          <Text className="font-semibold text-white">Log in</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView className="flex-1 bg-white" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: "Choose a new password" }} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="px-4 py-10">
        <Text className="text-2xl font-bold text-ink">Choose a new password</Text>

        <View className="mt-6 gap-4">
          {typeof params.token === "string" && params.token.trim().length > 0 ? null : (
            <LabeledInput
              label="Reset code"
              hint="From your password-reset email."
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
            />
          )}
          <LabeledInput
            label="New password"
            hint="At least 12 characters."
            value={password}
            onChangeText={setPassword}
            autoComplete="new-password"
            secureTextEntry
          />
          <LabeledInput
            label="Confirm password"
            hint={passwordsMismatch ? "Passwords don't match." : undefined}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            autoComplete="new-password"
            secureTextEntry
          />
          <Pressable
            disabled={!canSubmit}
            onPress={() => reset.mutate()}
            accessibilityRole="button"
            className={
              canSubmit
                ? "w-full rounded-md bg-rausch px-4 py-3 active:bg-rausch-dark"
                : "w-full rounded-md bg-line px-4 py-3"
            }
          >
            <Text className="text-center font-semibold text-white">
              {reset.isPending ? "Saving…" : "Set new password"}
            </Text>
          </Pressable>
        </View>

        {reset.isError ? (
          <View className="mt-4">
            <ErrorNotice error={reset.error} />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
