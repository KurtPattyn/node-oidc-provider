const { merge } = require('lodash');
const assert = require('assert');
const { generate: tokenHash } = require('oidc-token-hash');

const getMask = require('../helpers/claims');
const epochTime = require('../helpers/epoch_time');
const JWT = require('../helpers/jwt');
const { InvalidClientMetadata } = require('../helpers/errors');
const instance = require('../helpers/weak_cache');

const hashes = ['at_hash', 'c_hash', 'rt_hash', 's_hash'];

function ensureConform(audiences, clientId) {
  assert(Array.isArray(audiences), 'audiences must be an array');

  const value = Array.from(audiences);
  if (!value.includes(clientId)) {
    value.unshift(clientId);
  }

  return value;
}

module.exports = function getIdToken(provider) {
  const Claims = getMask(instance(provider).configuration());

  return class IdToken {
    constructor(available, sector) {
      assert.equal(
        typeof available, 'object',
        'expected claims to be an object, are you sure claims() method resolves with or returns one?',
      );
      this.extra = {};
      this.available = available;
      this.sector = sector;
    }

    static get expiresIn() { return instance(provider).configuration(`ttl.${this.name}`); }

    set(key, value) { this.extra[key] = value; }

    payload() {
      const mask = new Claims(this.available, this.sector);

      mask.scope(this.scope);
      mask.mask(this.mask);

      return merge(mask.result(), this.extra);
    }

    async sign(client, {
      use = 'idtoken',
      audiences = null,
      expiresAt = null,
      noExp = null,
    } = {}) {
      const expiresIn = (() => {
        if (expiresAt) return expiresAt - epochTime();
        return undefined;
      })();

      const alg = use === 'userinfo' ? client.userinfoSignedResponseAlg : client.idTokenSignedResponseAlg;
      const payload = this.payload();

      hashes.forEach((claim) => {
        if (payload[claim]) payload[claim] = tokenHash(payload[claim], alg);
      });

      const signed = await (() => {
        if (!alg) return JSON.stringify(payload);

        const keystore = alg && alg.startsWith('HS') ? client.keystore : instance(provider).keystore;
        const key = keystore && keystore.get({ alg });

        return JWT.sign(payload, key, alg, {
          authorizedParty: audiences ? client.clientId : undefined,
          audience: audiences ? ensureConform(audiences, client.clientId) : client.clientId,
          expiresIn: noExp ? undefined : (expiresIn || this.constructor.expiresIn),
          issuer: provider.issuer,
          subject: payload.sub,
        });
      })();

      const encryption = use === 'userinfo' ? {
        alg: client.userinfoEncryptedResponseAlg,
        enc: client.userinfoEncryptedResponseEnc,
      } : {
        alg: client.idTokenEncryptedResponseAlg,
        enc: client.idTokenEncryptedResponseEnc,
      };

      if (!encryption.enc) return signed;
      if (client.keystore.stale()) await client.keystore.refresh();

      const encryptionKey = client.keystore.get({ alg: encryption.alg });
      if (!encryptionKey) {
        throw new InvalidClientMetadata(`no suitable encryption key found (${encryption.alg})`);
      }
      return JWT.encrypt(signed, encryptionKey, encryption.enc, encryption.alg, alg ? undefined : 'json');
    }

    static async validate(jwt, client) {
      const alg = client.idTokenSignedResponseAlg;
      const opts = {
        ignoreExpiration: true,
        issuer: provider.issuer,
        clockTolerance: instance(provider).configuration('clockTolerance'),
      };

      const keyOrStore = (() => {
        if (/^(ES|RS)\d{3}/.exec(alg)) {
          return instance(provider).keystore;
        } else if (alg.startsWith('HS')) {
          return client.keystore;
        }
        return undefined;
      })();

      if (keyOrStore !== undefined) return JWT.verify(jwt, keyOrStore, opts);

      const decode = JWT.decode(jwt);
      JWT.assertPayload(decode.payload, opts);
      return decode;
    }
  };
};
