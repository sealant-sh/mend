const values = new Map<string, string>();

export const storage = {
  getItem: async (key: string) => values.get(key) ?? null,
  setItem: async (key: string, value: string) => void values.set(key, value),
  removeItem: async (key: string) => void values.delete(key),
};

export const secureStore = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: storage.getItem,
  setItemAsync: storage.setItem,
  deleteItemAsync: storage.removeItem,
};
