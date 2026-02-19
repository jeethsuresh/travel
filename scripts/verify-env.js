#!/usr/bin/env node
/**
 * Verify that all required environment variables are present before building for Capacitor
 */

const requiredVars = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
];

const missing = requiredVars.filter(varName => !process.env[varName]);

if (missing.length > 0) {
  console.error('❌ Missing required environment variables:');
  missing.forEach(varName => console.error(`   - ${varName}`));
  console.error('\n💡 Make sure your .env file exists and contains all required variables.');
  console.error('   See .env.example for reference.\n');
  process.exit(1);
}

console.log('✅ All required environment variables are present');
console.log('   Variables will be embedded in the build output.\n');
