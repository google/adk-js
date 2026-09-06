/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TS counterpart of adk-python contributing/samples/tools/pydantic_argument.
 *
 * Simple agent demonstrating Pydantic model arguments in tools.
 *
 * Pydantic models map onto zod objects: `Optional[UserPreferences]` becomes
 * `UserPreferences.nullish().default(null)` and
 * `Union[UserProfile, CompanyProfile]` becomes `z.union([...])`. adk-js runs
 * the model's arguments through `schema.parse()` before `execute`, so the
 * handler receives validated, default-filled data exactly as the Python side
 * receives validated model instances.
 */
import {FunctionTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

import {PARITY_MODEL} from '../model.ts';

/** A user's profile information. */
const UserProfile = z.object({
  name: z.string(),
  age: z.number().int(),
  email: z.string().nullish().default(null),
});

/** A user's preferences. */
const UserPreferences = z.object({
  theme: z.string().default('light'),
  language: z.string().default('English'),
  notifications_enabled: z.boolean().default(true),
});

/** A company's profile information. */
const CompanyProfile = z.object({
  company_name: z.string(),
  industry: z.string(),
  employee_count: z.number().int(),
  website: z.string().nullish().default(null),
});

const createFullUserAccount = new FunctionTool({
  name: 'create_full_user_account',
  description:
    'Create a complete user account with profile and optional preferences.',
  parameters: z.object({
    profile: UserProfile.describe("The user's profile information (required)"),
    preferences: UserPreferences.nullish()
      .default(null)
      .describe('Optional user preferences (Union[UserPreferences, None])'),
  }),
  execute: ({profile, preferences}) => {
    // Use default preferences if not provided.
    const resolved = preferences ?? UserPreferences.parse({});

    // Python reports `type(x).__name__`; zod validates against a schema rather
    // than instantiating a class, so the model names are spelled out to keep
    // the tool response byte-identical.
    return {
      status: 'account_created',
      message: `Full account created for ${profile.name}!`,
      profile: {
        name: profile.name,
        age: profile.age,
        email: profile.email || 'Not provided',
        profile_type: 'UserProfile',
      },
      preferences: {
        theme: resolved.theme,
        language: resolved.language,
        notifications_enabled: resolved.notifications_enabled,
        preferences_type: 'UserPreferences',
      },
      conversion_demo: {
        profile_converted: 'JSON dict → UserProfile instance',
        preferences_converted: 'JSON dict → UserPreferences instance',
      },
    };
  },
});

const createEntityProfile = new FunctionTool({
  name: 'create_entity_profile',
  description: 'Create a profile for either a user or a company.',
  parameters: z.object({
    entity: z
      .union([UserProfile, CompanyProfile])
      .describe('Either a UserProfile or CompanyProfile (Union type)'),
  }),
  execute: ({entity}) => {
    // Python branches on `isinstance`; the zod union has already picked a
    // branch, so re-checking which schema accepts the value is the equivalent.
    if (UserProfile.safeParse(entity).success) {
      const user = entity as z.infer<typeof UserProfile>;
      return {
        status: 'user_profile_created',
        entity_type: 'user',
        message: `User profile created for ${user.name}!`,
        profile: {
          name: user.name,
          age: user.age,
          email: user.email || 'Not provided',
          model_type: 'UserProfile',
        },
      };
    }
    if (CompanyProfile.safeParse(entity).success) {
      const company = entity as z.infer<typeof CompanyProfile>;
      return {
        status: 'company_profile_created',
        entity_type: 'company',
        message: `Company profile created for ${company.company_name}!`,
        profile: {
          company_name: company.company_name,
          industry: company.industry,
          employee_count: company.employee_count,
          website: company.website || 'Not provided',
          model_type: 'CompanyProfile',
        },
      };
    }
    return {
      status: 'error',
      message: `Unexpected entity type: ${typeof entity}`,
    };
  },
});

// Create the agent with all Pydantic tools
export const rootAgent = new LlmAgent({
  model: PARITY_MODEL,
  name: 'profile_agent',
  description:
    'Helpful assistant that helps creating accounts and profiles for users' +
    ' and companies',
  instruction: `
You are a helpful assistant that can create accounts and profiles for users and companies.

When someone asks you to create a user account, use \`create_full_user_account\`.
When someone asks you to create a profile and it's unclear whether they mean a user or company, use \`create_entity_profile\`.
When someone specifically mentions a company, use \`create_entity_profile\`.

Use the tools with the structured data provided by the user.
`,
  tools: [createFullUserAccount, createEntityProfile],
});
