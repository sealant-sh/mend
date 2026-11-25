// Expo's Metro config, with Sentry's serializer (SLNT-1357): it gives each bundle a debug ID and
// writes it into the bundle's source map, so a stack trace from a phone maps back to the source
// that built it, whichever over-the-air update it came from. Without a DSN the app reports nothing;
// the debug ID is an inert line in the bundle.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
