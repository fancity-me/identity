import {Injectable} from '@angular/core';
import {Observable, Subject} from 'rxjs';
import {v4 as uuid} from 'uuid';
import {AccessLevel, PublicUserInfo} from '../types/identity';
import {CryptoService} from './crypto.service';
import {GlobalVarsService} from './global-vars.service';
import {CookieService} from 'ngx-cookie';
import {SigningService} from './signing.service';
import {HttpParams} from '@angular/common/http';
import {BackendAPIService} from './backend-api.service';
import {AccountService} from './account.service';
import {
  Transaction,
  TransactionMetadataBasicTransfer,
  TransactionMetadataBitcoinExchange,
  TransactionMetadataCreatorCoin,
  TransactionMetadataCreatorCoinTransfer,
  TransactionMetadataFollow,
  TransactionMetadataLike,
  TransactionMetadataPrivateMessage,
  TransactionMetadataSubmitPost,
  TransactionMetadataSwapIdentity,
  TransactionMetadataUpdateBitcoinUSDExchangeRate,
  TransactionMetadataUpdateGlobalParams,
  TransactionMetadataUpdateProfile,
  TransactionMetadataNFTTransfer,
  TransactionMetadataAcceptNFTTransfer,
  TransactionMetadataBurnNFT,
  TransactionMetadataAuthorizeDerivedKey,
  TransactionMetadataNFTBid,
  TransactionMetadataAcceptNFTBid,
  TransactionMetadataUpdateNFT,
  TransactionMetadataCreateNFT
} from '../lib/deso/transaction';

@Injectable({
  providedIn: 'root'
})
export class IdentityService {
  // All outbound request promises we still need to resolve
  private outboundRequests: {[key: string]: any} = {};

  // Opener can be null, parent is never null
  private currentWindow = opener || parent;

  // Embed component checks for browser support
  browserSupported = true;

  constructor(
    private cryptoService: CryptoService,
    private globalVars: GlobalVarsService,
    private cookieService: CookieService,
    private signingService: SigningService,
    private accountService: AccountService,
    private backendApi: BackendAPIService,
  ) {
    window.addEventListener('message', (event) => this.handleMessage(event));
  }

  // Outgoing Messages

  initialize(): Observable<any> {
    return this.send('initialize', {});
  }

  storageGranted(): void {
    this.cast('storageGranted');
  }

  login(payload: {
    users: {[key: string]: PublicUserInfo},
    publicKeyAdded?: string,
    signedUp?: boolean
    signedTransactionHex?: string,
    jumioSuccess?: boolean,
    phoneNumberSuccess?: boolean,
  }): void {
    this.cast('login', payload);
  }

  derive(payload: {
    publicKey: string,
  }): void {
    this.backendApi.GetAppState().subscribe( res => {
      const blockHeight = res.BlockHeight;
      const derivedPrivateUserInfo = this.accountService.getDerivedPrivateUser(payload.publicKey, blockHeight);
      if (this.globalVars.callback) {
        // If callback is passed, we redirect to it with payload as URL parameters.
        let httpParams = new HttpParams();
        for (const key in derivedPrivateUserInfo) {
          if (derivedPrivateUserInfo.hasOwnProperty(key)) {
            httpParams = httpParams.append(key, (derivedPrivateUserInfo as any)[key].toString());
          }
        }
        window.location.href = this.globalVars.callback + `?${httpParams.toString()}`;
      } else {
        this.cast('derive', derivedPrivateUserInfo);
      }
    });
  }

  // Incoming Messages

  private handleBurn(data: any): void {
    if (!this.approve(data, AccessLevel.Full)) {
      return;
    }

    const { id, payload: { encryptedSeedHex, unsignedHashes } } = data;
    const seedHex = this.cryptoService.decryptSeedHex(encryptedSeedHex, this.globalVars.hostname);
    const signedHashes = this.signingService.signHashes(seedHex, unsignedHashes);

    this.respond(id, {
      signedHashes,
    });
  }

  private handleSignETH(data: any): void {
    if (!this.approve(data, AccessLevel.Full)) {
      return;
    }

    const { id, payload: { encryptedSeedHex, unsignedHashes } } = data;
    const seedHex = this.cryptoService.decryptSeedHex(encryptedSeedHex, this.globalVars.hostname);
    const signatures = this.signingService.signHashesETH(seedHex, unsignedHashes);

    this.respond(id, {
      signatures,
    });
  }

  private handleSign(data: any): void {
    const { id, payload: { encryptedSeedHex, transactionHex } } = data;

    // This will tell us whether we need full signing access or just ApproveLarge
    // level of access.
    const requiredAccessLevel = this.getRequiredAccessLevel(transactionHex);

    // In the case that approve() fails, it responds with a message indicating
    // that approvalRequired = true, which the caller can then uses to trigger
    // the /approve UI.
    if (!this.approve(data, requiredAccessLevel)) {
      return;
    }

    // If we get to this point, no approval UI was required. This typically
    // happens if the caller has full signing access or signing access for
    // non-spending txns such as like, post, update profile, etc. In the
    // latter case we need a subsequent check to ensure that the txn is not
    // sending money to any public keys other than the sender himself.
    if (!this.approveSpending(data)) {
      return;
    }

    const seedHex = this.cryptoService.decryptSeedHex(encryptedSeedHex, this.globalVars.hostname);
    const signedTransactionHex = this.signingService.signTransaction(seedHex, transactionHex);

    this.respond(id, {
      signedTransactionHex,
    });
  }

  // Encrypt with shared secret
  private handleEncrypt(data: any): void{
    if (!this.approve(data, AccessLevel.ApproveAll)){
      return;
    }

    const { id, payload: { encryptedSeedHex, recipientPublicKey, message} } = data;
    const seedHex = this.cryptoService.decryptSeedHex(encryptedSeedHex, this.globalVars.hostname);
    const encryptedMessage = this.signingService.encryptMessage(seedHex, recipientPublicKey, message);
    this.respond(id, {
      encryptedMessage
    });
  }

  private handleDecrypt(data: any): void {
    if (!this.approve(data, AccessLevel.ApproveAll)) {
      return;
    }

    const seedHex = this.cryptoService.decryptSeedHex(data.payload.encryptedSeedHex, this.globalVars.hostname);
    const id = data.id;

    let decryptedHexes;
    if (data.payload.encryptedHexes){
      // Legacy public key decryption
      const encryptedHexes = data.payload.encryptedHexes;
      decryptedHexes = this.signingService.decryptMessagesLegacy(seedHex, encryptedHexes);
    } else {
      // Shared secret decryption
      const encryptedMessages = data.payload.encryptedMessages;
      decryptedHexes = this.signingService.decryptMessages(seedHex, encryptedMessages);
    }

    this.respond(id, {
      decryptedHexes
    });
  }

  private handleJwt(data: any): void {
    if (!this.approve(data, AccessLevel.ApproveAll)) {
      return;
    }

    const { id, payload: { encryptedSeedHex } } = data;
    const seedHex = this.cryptoService.decryptSeedHex(encryptedSeedHex, this.globalVars.hostname);
    const jwt = this.signingService.signJWT(seedHex);

    this.respond(id, {
      jwt
    });
  }

  private async handleInfo(event: MessageEvent): Promise<void> {
    // check storage access API
    let hasStorageAccess = true;
    if (this.cryptoService.mustUseStorageAccess()) {
      hasStorageAccess = await document.hasStorageAccess();
    }

    // check for localStorage access
    let hasLocalStorageAccess;
    try {
      hasLocalStorageAccess = !!localStorage;
    } catch (e) {
      hasLocalStorageAccess = false;
    }

    // check for cookie access
    this.cookieService.put('deso-test-access', 'true');
    const hasCookieAccess = !!this.cookieService.get('deso-test-access');

    // store if browser is supported or not
    this.browserSupported = hasCookieAccess || hasLocalStorageAccess;

    this.respond(event.data.id, {
      hasCookieAccess,
      hasStorageAccess,
      hasLocalStorageAccess,
      browserSupported: this.browserSupported,
    });
  }


  // Access levels

  private getRequiredAccessLevel(transactionHex: string): AccessLevel {
    const txBytes = new Buffer(transactionHex, 'hex');
    const transaction = Transaction.fromBytes(txBytes)[0] as Transaction<any>;

    switch (transaction.metadata.constructor) {
      case TransactionMetadataBasicTransfer:
      case TransactionMetadataBitcoinExchange:
      case TransactionMetadataUpdateBitcoinUSDExchangeRate:
      case TransactionMetadataCreatorCoin:
      case TransactionMetadataCreatorCoinTransfer:
      case TransactionMetadataSwapIdentity:
      case TransactionMetadataUpdateGlobalParams:
      case TransactionMetadataUpdateProfile:
      case TransactionMetadataCreateNFT:
      case TransactionMetadataUpdateNFT:
      case TransactionMetadataAcceptNFTBid:
      case TransactionMetadataNFTBid:
      case TransactionMetadataNFTTransfer:
      case TransactionMetadataAcceptNFTTransfer:
      case TransactionMetadataBurnNFT:
      case TransactionMetadataAuthorizeDerivedKey:
        return AccessLevel.Full;

      case TransactionMetadataFollow:
      case TransactionMetadataPrivateMessage:
      case TransactionMetadataSubmitPost:
      case TransactionMetadataLike:
        return AccessLevel.ApproveLarge;
    }

    return AccessLevel.Full;
  }

  private hasAccessLevel(data: any, requiredAccessLevel: AccessLevel): boolean {
    const { payload: { encryptedSeedHex, accessLevel, accessLevelHmac }} = data;
    if (accessLevel < requiredAccessLevel) {
      return false;
    }

    const seedHex = this.cryptoService.decryptSeedHex(encryptedSeedHex, this.globalVars.hostname);
    return this.cryptoService.validAccessLevelHmac(accessLevel, seedHex, accessLevelHmac);
  }

  // This method checks if transaction in the payload has correct outputs for requested AccessLevel.
  private approveSpending(data: any): boolean {
    const { payload: { accessLevel, transactionHex }} = data;

    // If the requested access level is ApproveLarge, we want to confirm that transaction doesn't
    // attempt sending $DESO to a non-owner public key. If it does, we respond with approvalRequired.
    if (accessLevel === AccessLevel.ApproveLarge) {
      const txBytes = new Buffer(transactionHex, 'hex');
      const transaction = Transaction.fromBytes(txBytes)[0] as Transaction<any>;
      for (const output of transaction.outputs) {
        if (output.publicKey.toString('hex') !== transaction.publicKey.toString('hex')) {
          this.respond(data.id, {approvalRequired: true});
          return false;
        }
      }
    }
    return true;
  }

  private approve(data: any, accessLevel: AccessLevel): boolean {
    const hasAccess = this.hasAccessLevel(data, accessLevel);
    const hasEncryptionKey = this.cryptoService.hasSeedHexEncryptionKey(this.globalVars.hostname);

    if (!hasAccess || !hasEncryptionKey) {
      this.respond(data.id, { approvalRequired: true });
      return false;
    }

    return true;
  }

  // Message handling

  private handleMessage(event: MessageEvent): void {
    const { data } = event;
    const { service, method } = data;

    if (service !== 'identity') { return; }

    // Methods are present on incoming requests but not responses
    if (method) {
      this.handleRequest(event);
    } else {
      this.handleResponse(event);
    }
  }

  private handleRequest(event: MessageEvent): void {
    const data = event.data;
    const method = data.method;

    if (method === 'burn') {
      this.handleBurn(data);
    } else if (method === 'encrypt'){
      this.handleEncrypt(data);
    } else if (method === 'decrypt') {
      this.handleDecrypt(data);
    } else if (method === 'sign') {
      this.handleSign(data);
    } else if (method === 'signETH') {
      this.handleSignETH(data);
    } else if (method === 'jwt') {
      this.handleJwt(data);
    } else if (method === 'info') {
      this.handleInfo(event);
    } else {
      console.error('Unhandled identity request');
      console.error(event);
    }
  }

  private handleResponse(event: MessageEvent): void {
    const { data: { id, payload }, origin } = event;
    const hostname = new URL(origin).hostname;
    const result = {
      id,
      payload,
      hostname,
    };

    const req = this.outboundRequests[id];
    req.next(result);
    req.complete();
    delete this.outboundRequests[id];
  }

  // Send a new message and expect a response
  private send(method: string, payload: any): Subject<any> {
    const id = uuid();
    const subject = new Subject();
    this.outboundRequests[id] = subject;

    this.postMessage({
      id,
      service: 'identity',
      method,
      payload,
    });

    return subject;
  }

  // Respond to a received message
  private respond(id: string, payload: any): void {
    this.postMessage({
      id,
      service: 'identity',
      payload
    });
  }

  // Transmit a message without expecting a response
  private cast(method: string, payload?: any): void {
    this.postMessage({
      id: null,
      service: 'identity',
      method,
      payload,
    });
  }

  // Post message to correct client
  private postMessage(message: any): void {
    if (this.globalVars.webview) {
      if (this.currentWindow.webkit?.messageHandlers?.desoIdentityAppInterface !== undefined) {
        // iOS Webview with registered "desoIdentityAppInterface" handler
        this.currentWindow.webkit.messageHandlers.desoIdentityAppInterface.postMessage(message, '*');
      } else if (this.currentWindow.desoIdentityAppInterface !== undefined) {
        // Android Webview with registered "desoIdentityAppInterface" handler
        this.currentWindow.desoIdentityAppInterface.postMessage(JSON.stringify(message), '*');
      } else if (this.currentWindow.ReactNativeWebView !== undefined) {
        // React Native Webview with registered "ReactNativeWebView" handler
        this.currentWindow.ReactNativeWebView.postMessage(JSON.stringify(message));
      } else if (this.currentWindow.webkit?.messageHandlers?.bitcloutIdentityAppInterface !== undefined) {
        // DEPRECATED: iOS Webview with registered "bitcloutIdentityAppInterface" handler
        this.currentWindow.webkit.messageHandlers.bitcloutIdentityAppInterface.postMessage(message, '*');
      } else if (this.currentWindow.bitcloutIdentityAppInterface !== undefined) {
        // DEPRECATED: Android Webview with registered "bitcloutIdentityAppInterface" handler
        this.currentWindow.bitcloutIdentityAppInterface.postMessage(JSON.stringify(message), '*');
      }
    } else {
      this.currentWindow.postMessage(message, '*');
    }
  }
}
