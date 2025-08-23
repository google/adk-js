/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents the secret token value for HTTP authentication, like user name,
 * password, oauth token, etc.
 */
export interface HttpCredentials {
  username?: string;
  password?: string;
  token?: string;
}

/**
 * The credentials and metadata for HTTP authentication.
 */
export interface HttpAuth {
  /**
   * The name of the HTTP Authorization scheme to be used in the Authorization
   * header as defined in RFC7235. The values used SHOULD be registered in the
   * IANA Authentication Scheme registry.
   * Examples: 'basic', 'bearer'
   */
  scheme: string;
  credentials: HttpCredentials;
}

/**
 * Represents credential value and its metadata for a OAuth2 credential.
 */
export interface OAuth2Auth {
  clientId?: string;
  clientSecret?: string;
  /**
   * tool or adk can generate the authUri with the state info thus client can
   * verify the state
   */
  authUri?: string;
  state?: string;
  /**
   * tool or adk can decide the redirect_uri if they don't want client to decide
   */
  redirectUri?: string;
  authResponseUri?: string;
  authCode?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  expiresIn?: number;
}

/**
 * Represents Google Service Account configuration.
 * @example
 * config = {
 *   type: "service_account",
 *   projectId: "your_project_id",
 *   privateKeyId: "your_private_key_id",
 *   privateKey: "-----BEGIN PRIVATE KEY-----...",
 *   clientEmail: "...@....iam.gserviceaccount.com",
 *   clientId: "your_client_id",
 *   authUri: "https://accounts.google.com/o/oauth2/auth",
 *   tokenUri: "https://oauth2.googleapis.com/token",
 *   authProviderX509CertUrl: "https://www.googleapis.com/oauth2/v1/certs",
 *   clientX509CertUrl: "https://www.googleapis.com/robot/v1/metadata/x509/...",
 *   universeDomain: "googleapis.com",
 * }
 */
export interface ServiceAccountCredential {
  /**
   * The type should be 'service_account'.
   */
  type: 'service_account';

  /**
   * The project ID of the Google Cloud project.
   */
  projectId: string;

  /**
   * The ID of the private key.
   */
  privateKeyId: string;

  /**
   * The private key value.
   */
  privateKey: string;

  /**
   * The client email.
   */
  clientEmail: string;

  /**
   * The client ID.
   */
  clientId: string;

  /**
   * The authorization URI.
   */
  authUri: string;

  /**
   * The token URI.
   */
  tokenUri: string;

  /**
   * URL for auth provider's X.509 cert.
   */
  authProviderX509CertUrl: string;

  /**
   * URL for the client's X.509 cert.
   */
  clientX509CertUrl: string;

  /**
   * The universe domain.
   */
  universeDomain: string;
}

/**
 * Represents Google Service Account configuration.
 */
export interface ServiceAccount {
  serviceAccountCredential?: ServiceAccountCredential;
  scopes?: string[];
  useDefaultCredential?: boolean;
}

/*
 * Represents the type of authentication credential.
 */
export enum AuthCredentialTypes {
  /**
   * API Key credential:
   * @see {@link https://swagger.io/docs/specification/v3_0/authentication/api-keys/}
   */
  API_KEY = 'apiKey',

  /**
   * Credentials for HTTP Auth schemes:
   * @see {@link https://www.iana.org/assignments/http-authschemes/http-auth-schemes.xhtml}
   */
  HTTP = 'http',

  /**
   * OAuth2 credentials:
   * @see {@link https://swagger.io/docs/specification/v3_0/authentication/oauth2/}
   */
  OAUTH2 = 'oauth2',

  /**
   * Open ID Connect credentials:
   * @see {@link https://swagger.io/docs/specification/v3_0/authentication/openid-connect-discovery/}
   */
  OPEN_ID_CONNECT = 'openIdConnect',

  /**
   * Service Account credentials:
   * @see {@link https://cloud.google.com/iam/docs/service-account-creds}
   */
  SERVICE_ACCOUNT = 'serviceAccount',
}

/**
 * Data class representing an authentication credential.
 *
 * To exchange for the actual credential, please use
 * CredentialExchanger.exchangeCredential().
 * 
 * @example
 * // API Key Auth
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.API_KEY,
 *   apiKey: "your_api_key",
 * };
 *
 * @example
 * // HTTP Auth
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.HTTP,
 *   http: {
 *     scheme: "basic",
 *     credentials: {
 *       username: "user",
 *       password: "password",
 *     },
 *   }
 * }
 *
 * @example
 * // OAuth2 Bearer Token in HTTP Header
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.HTTP,
 *   http: {
 *     scheme: "bearer",
 *     credentials: {
 *       token: "your_access_token",
 *     },
 *   }
 * }
 *
 * @example
 * // OAuth2 Auth with Authorization Code Flow
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.OAUTH2,
 *   oauth2: {
 *     clientId: "your_client_id",
 *     clientSecret: "your_client_secret",
 *   }
 * }
 *
 * @example:
 * // Open ID Connect Auth
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.OPEN_ID_CONNECT,
 *   oauth2: {
 *     clientId: "1234",
 *     clientSecret: "secret",
 *     redirectUri: "https://example.com",
 *     scopes: ["scope1", "scope2"],
 *   }
 * }
 *
 * @example:
 * // Auth with resource reference
 * const authCredential: AuthCredential = {
 *   authType: AuthCredentialTypes.API_KEY,
 *   resourceRef: "projects/1234/locations/us-central1/resources/resource1"
 * }
 */
export interface AuthCredential {
  authType: AuthCredentialTypes;

  /**
   * Resource reference for the credential.
   * This will be supported in the future.
   */
  resourceRef?: string;

  apiKey?: string;
  http?: HttpAuth;
  serviceAccount?: ServiceAccount;
  oauth2?: OAuth2Auth;
}