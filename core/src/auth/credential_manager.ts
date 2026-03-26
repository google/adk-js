/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {Context} from '../agents/context.js';
import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthProviderRegistry} from './auth_provider_registry.js';
import {OpenIdConnectWithConfig} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';
import {CredentialExchangerRegistry} from './exchanger/credential_exchanger_registry.js';
import {ServiceAccountCredentialExchanger} from './exchanger/service_account_credential_exchanger.js';
import {OAuth2CredentialExchanger} from './oauth2/oauth2_credential_exchanger.js';
import {OAuth2DiscoveryManager} from './oauth2/oauth2_discovery.js';
import {CredentialRefresherRegistry} from './refresher/credential_refresher_registry.js';
import {OAuth2CredentialRefresher} from './oauth2/oauth2_credential_refresher.js';
import {logger} from '../utils/logger.js';

/**
 * Manages authentication credentials through a structured workflow.
 *
 * This class orchestrates the lifecycle of authentication credentials,
 * from loading to preparation for use. It provides a centralized interface
 * for handling various credential types and authentication schemes by
 * utilizing available registries (AuthProvider) and context features.
 *
 * This class is only for use by Agent Development Kit.
 */
export class CredentialManager {
  private readonly authConfig: AuthConfig;
  private readonly authProviderRegistry: AuthProviderRegistry;
  private readonly exchangerRegistry: CredentialExchangerRegistry;
  private readonly refresherRegistry: CredentialRefresherRegistry;
  private readonly discoveryManager: OAuth2DiscoveryManager;

  constructor(authConfig: AuthConfig) {
    this.authConfig = authConfig;
    this.authProviderRegistry = new AuthProviderRegistry();
    this.exchangerRegistry = new CredentialExchangerRegistry();
    this.refresherRegistry = new CredentialRefresherRegistry();
    this.discoveryManager = new OAuth2DiscoveryManager();

    const oauth2Exchanger = new OAuth2CredentialExchanger();
    this.exchangerRegistry.register(
      AuthCredentialTypes.OAUTH2,
      oauth2Exchanger,
    );
    this.exchangerRegistry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2Exchanger,
    );
    this.exchangerRegistry.register(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new ServiceAccountCredentialExchanger(),
    );

    const oauth2Refresher = new OAuth2CredentialRefresher();
    this.refresherRegistry.register(
      AuthCredentialTypes.OAUTH2,
      oauth2Refresher,
    );
    this.refresherRegistry.register(
      AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2Refresher,
    );
  }

  /**
   * Requests credentials using the current context.
   *
   * @param context The current execution context.
   */
  async requestCredential(context: Context): Promise<void> {
    context.requestCredential(this.authConfig);
  }

  /**
   * Retrieves authentication credentials, either through a registered provider
   * or by checking context state.
   *
   * @param context The current execution context.
   * @returns The AuthCredential if available, undefined otherwise.
   */
  async getAuthCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const provider = this.authProviderRegistry.getProvider(
      this.authConfig.authScheme,
    );
    if (provider) {
      const providedCredential = await provider.getAuthCredential(
        this.authConfig,
        context,
      );
      if (!providedCredential) {
        throw new Error('AuthProvider did not return a credential.');
      }
      if (
        providedCredential.oauth2 &&
        !providedCredential.oauth2.accessToken &&
        providedCredential.oauth2.authUri
      ) {
        this.authConfig.exchangedAuthCredential = providedCredential;
        return undefined;
      }
      return providedCredential;
    }

    await this._validateCredential();

    if (this._isCredentialReady()) {
      return this.authConfig.rawAuthCredential;
    }

    let credential = await this._loadExistingCredential(context);

    let wasFromAuthResponse = false;
    if (!credential) {
      credential = await this._loadFromAuthResponse(context);
      wasFromAuthResponse = true;
    }

    if (!credential) {
      if (this._isClientCredentialsFlow()) {
        credential = this.authConfig.rawAuthCredential;
      } else {
        return undefined;
      }
    }

    let wasExchanged = false;
    if (credential) {
      const exchangeResult = await this._exchangeCredential(credential);
      credential = exchangeResult.credential;
      wasExchanged = exchangeResult.wasExchanged;
    }

    let wasRefreshed = false;
    if (credential && !wasExchanged) {
      const refreshResult = await this._refreshCredential(credential);
      credential = refreshResult.credential;
      wasRefreshed = refreshResult.wasRefreshed;
    }

    if (credential && (wasFromAuthResponse || wasExchanged || wasRefreshed)) {
      await this._saveCredential(context, credential);
    }

    return credential;
  }

  private async _validateCredential(): Promise<void> {
    if (!this.authConfig.rawAuthCredential) {
      if (
        this.authConfig.authScheme.type === 'oauth2' ||
        this.authConfig.authScheme.type === 'openIdConnect'
      ) {
        throw new Error(
          `rawAuthCredential is required for authScheme type ${this.authConfig.authScheme.type}`,
        );
      }
    }

    const rawCredential = this.authConfig.rawAuthCredential;
    if (rawCredential) {
      if (
        (rawCredential.authType === AuthCredentialTypes.OAUTH2 ||
          rawCredential.authType === AuthCredentialTypes.OPEN_ID_CONNECT) &&
        !rawCredential.oauth2
      ) {
        throw new Error(
          `oauth2 is required for credential type ${rawCredential.authType}`,
        );
      }
    }

    if (this._missingOauthInfo() && !(await this._populateAuthScheme())) {
      throw new Error(
        'OAuth scheme info is missing and auto-discovery failed.',
      );
    }
  }

  private _isCredentialReady(): boolean {
    const rawCredential = this.authConfig.rawAuthCredential;
    if (!rawCredential) {
      return false;
    }

    return (
      rawCredential.authType === AuthCredentialTypes.API_KEY ||
      rawCredential.authType === AuthCredentialTypes.HTTP
    );
  }

  private async _loadExistingCredential(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    return this._loadFromCredentialService(context);
  }

  private async _loadFromCredentialService(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    const credentialService = context.invocationContext.credentialService;
    if (credentialService) {
      return credentialService.loadCredential(this.authConfig, context);
    }
    return undefined;
  }

  private async _loadFromAuthResponse(
    context: Context,
  ): Promise<AuthCredential | undefined> {
    return context.getAuthResponse(this.authConfig);
  }

  private async _exchangeCredential(
    credential: AuthCredential,
  ): Promise<{credential: AuthCredential; wasExchanged: boolean}> {
    const exchanger = this.exchangerRegistry.getExchanger(credential.authType);
    if (!exchanger) {
      return {credential, wasExchanged: false};
    }

    const exchangeResult = await exchanger.exchange({
      authCredential: credential,
      authScheme: this.authConfig.authScheme,
    });
    return exchangeResult;
  }

  private async _refreshCredential(
    credential: AuthCredential,
  ): Promise<{credential: AuthCredential; wasRefreshed: boolean}> {
    const refresher = this.refresherRegistry.getRefresher(credential.authType);
    if (!refresher) {
      return {credential, wasRefreshed: false};
    }

    if (
      await refresher.isRefreshNeeded(credential, this.authConfig.authScheme)
    ) {
      const refreshedCredential = await refresher.refresh(
        credential,
        this.authConfig.authScheme,
      );
      return {credential: refreshedCredential, wasRefreshed: true};
    }

    return {credential, wasRefreshed: false};
  }

  private async _saveCredential(
    context: Context,
    credential: AuthCredential,
  ): Promise<void> {
    const credentialService = context.invocationContext.credentialService;
    if (credentialService) {
      const updatedConfig = {
        ...this.authConfig,
        exchangedAuthCredential: credential,
      };
      await credentialService.saveCredential(updatedConfig, context);
    }
  }

  private async _populateAuthScheme(): Promise<boolean> {
    const authScheme = this.authConfig.authScheme;
    // We assume it's OAuth2 for auto-discovery usually, or if it has an issuerUrl.
    // In TS, we don't have ExtendedOAuth2 yet if it's not defined, but let's assume if it's OpenIdConnect or if we want to support it.
    // Let's assume if it's 'oauth2' or 'openIdConnect' and has issuerUrl (or if we can cast it if we define it).
    // Let's check if we can cast it safely or if it's a property in our custom OpenIdConnectWithConfig.
    // Let's assume for now it might not have issuerUrl if it's plain OpenAPI v3. If it's OpenIdConnectWithConfig, it might have it if we added it, but let's check our OpenIdConnectWithConfig in auth_schemes.ts. It didn't have issuerUrl in the view! Wait, let's check it again.
    // In auth_schemes.ts:
    // export interface OpenIdConnectWithConfig extends OpenAPIV3.OpenIdSecurityScheme { ... }
    // OpenAPIV3.OpenIdSecurityScheme has openIdConnectUrl. This might be used as issuerUrl or we should check if our custom one has it.
    // Let's use `openIdConnectUrl` if available.
    let issuerUrl: string | undefined = undefined;
    if (authScheme.type === 'openIdConnect') {
      issuerUrl = (authScheme as OpenAPIV3.OpenIdSecurityScheme)
        .openIdConnectUrl;
    } else if (authScheme.type === 'oauth2') {
      // In python, it was ExtendedOAuth2.issuer_url. In TS, let's see if we have it or if we should add it.
      // If we don't have it, we can't do auto-discovery. Let's skip if no issuerUrl.
    }

    if (!issuerUrl) {
      logger.warn('No issuerUrl available for auto-discovery.');
      return false;
    }

    const metadata =
      await this.discoveryManager.discoverAuthServerMetadata(issuerUrl);
    if (!metadata) {
      logger.warn('Auto-discovery failed to populate OAuth scheme info.');
      return false;
    }

    if (authScheme.type === 'oauth2') {
      const flows = (authScheme as OpenAPIV3.OAuth2SecurityScheme).flows;
      if (flows) {
        if (flows.implicit && !flows.implicit.authorizationUrl) {
          flows.implicit.authorizationUrl = metadata.authorization_endpoint;
        }
        if (flows.password && !flows.password.tokenUrl) {
          flows.password.tokenUrl = metadata.token_endpoint;
        }
        if (flows.clientCredentials && !flows.clientCredentials.tokenUrl) {
          flows.clientCredentials.tokenUrl = metadata.token_endpoint;
        }
        if (flows.authorizationCode) {
          if (!flows.authorizationCode.authorizationUrl) {
            flows.authorizationCode.authorizationUrl =
              metadata.authorization_endpoint;
          }
          if (!flows.authorizationCode.tokenUrl) {
            flows.authorizationCode.tokenUrl = metadata.token_endpoint;
          }
        }
      }
    }
    return true;
  }

  private _missingOauthInfo(): boolean {
    const authScheme = this.authConfig.authScheme;
    if (authScheme.type === 'oauth2') {
      const flows = (authScheme as OpenAPIV3.OAuth2SecurityScheme).flows;
      if (flows) {
        return (
          (flows.implicit !== undefined && !flows.implicit.authorizationUrl) ||
          (flows.password !== undefined && !flows.password.tokenUrl) ||
          (flows.clientCredentials !== undefined &&
            !flows.clientCredentials.tokenUrl) ||
          (flows.authorizationCode !== undefined &&
            (!flows.authorizationCode.authorizationUrl ||
              !flows.authorizationCode.tokenUrl))
        );
      }
    }
    return false;
  }

  private _isClientCredentialsFlow(): boolean {
    const authScheme = this.authConfig.authScheme;
    if (authScheme.type === 'oauth2') {
      const oauthScheme = authScheme as OpenAPIV3.OAuth2SecurityScheme;
      return oauthScheme.flows?.clientCredentials !== undefined;
    }
    if (authScheme.type === 'openIdConnect') {
      const oidcScheme = authScheme as OpenIdConnectWithConfig;
      return (
        oidcScheme.grantTypesSupported?.includes('client_credentials') === true
      );
    }
    return false;
  }
}
