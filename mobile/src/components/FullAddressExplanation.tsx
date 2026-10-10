import { ADDRESS_FIELD_PRIVACY_NOTE } from "@voteapp/api-client";
import { useRouter } from "expo-router";
import { Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";

type FullAddressExplanationProps = {
  visible: boolean;
  onClose: () => void;
};

export function FullAddressExplanation({ visible, onClose }: FullAddressExplanationProps) {
  const router = useRouter();

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 items-center justify-center p-4">
        <Pressable
          className="absolute inset-0 bg-ink/40"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
        />
        <View className="max-h-[88%] w-full max-w-md rounded-2xl bg-white p-6">
          <Text accessibilityRole="header" className="text-lg font-bold text-ink">
            Why do you need the full address?
          </Text>
          <ScrollView className="mt-3">
            <Text className="text-sm text-ink-soft">
              Your ballot depends on your voting districts, whose boundaries don’t follow ZIP
              codes. Two homes in the same ZIP can vote in different races.
            </Text>
            {/* Same paragraph as the web dialog, open-source link included. */}
            <Text className="mt-3 text-sm text-ink-soft">
              {ADDRESS_FIELD_PRIVACY_NOTE} Our source code is open and public{" "}
              <Text
                className="text-ink underline"
                accessibilityRole="link"
                onPress={() => void Linking.openURL("https://github.com/shu1513/electionssimplified")}
              >
                here
              </Text>
              .
            </Text>
            <Text
              className="mt-3 text-sm text-ink underline"
              accessibilityRole="link"
              onPress={() => {
                onClose();
                router.push("/legal/privacy");
              }}
            >
              Read our Privacy Policy
            </Text>
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            className="mt-5 self-end rounded-lg bg-rausch px-5 py-3 active:bg-rausch-dark"
          >
            <Text className="font-semibold text-white">Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
