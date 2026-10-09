/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/ratpool_escrow.json`.
 */
export type RatpoolEscrow = {
  "address": "Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj",
  "metadata": {
    "name": "ratpoolEscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "acceptAuthority",
      "discriminator": [
        107,
        86,
        198,
        91,
        33,
        12,
        107,
        160
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "cancel",
      "discriminator": [
        232,
        219,
        223,
        41,
        219,
        236,
        220,
        190
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimRefund",
      "discriminator": [
        15,
        16,
        30,
        161,
        255,
        228,
        97,
        60
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "playerAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeMatch",
      "discriminator": [
        79,
        174,
        36,
        80,
        233,
        185,
        176,
        239
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "feeAta",
          "writable": true
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "collect",
      "discriminator": [
        208,
        47,
        194,
        155,
        17,
        98,
        82,
        236
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createMatch",
      "discriminator": [
        107,
        2,
        184,
        145,
        70,
        142,
        17,
        165
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "vault",
          "docs": [
            "The vault: a token account whose only authority is the match PDA,",
            "which has no private key. Nobody can sign for it; only this program",
            "can, through the instructions that follow."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "entry",
          "type": "u64"
        }
      ]
    },
    {
      "name": "evict",
      "discriminator": [
        56,
        13,
        174,
        235,
        133,
        159,
        37,
        162
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        },
        {
          "name": "player",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "feeWallet",
          "docs": [
            "token account it must own."
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "program",
          "address": "Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj"
        },
        {
          "name": "programData"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "minPlayers",
          "type": "u8"
        },
        {
          "name": "refundDelay",
          "type": "i64"
        },
        {
          "name": "admission",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "join",
      "discriminator": [
        206,
        55,
        2,
        106,
        113,
        220,
        17,
        163
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "playerAta",
          "writable": true
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "admission",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "leave",
      "discriminator": [
        59,
        234,
        148,
        108,
        107,
        149,
        173,
        112
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "playerAta",
          "writable": true
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "proposeAuthority",
      "discriminator": [
        20,
        148,
        236,
        198,
        76,
        119,
        99,
        142
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "program",
          "address": "Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj"
        },
        {
          "name": "programData"
        }
      ],
      "args": [
        {
          "name": "new",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "recordReferral",
      "discriminator": [
        232,
        9,
        242,
        51,
        237,
        16,
        172,
        72
      ],
      "accounts": [
        {
          "name": "referral",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "player"
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "program",
          "address": "Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "player",
          "type": "pubkey"
        },
        {
          "name": "referrer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setReferrer",
      "discriminator": [
        115,
        251,
        55,
        0,
        166,
        189,
        25,
        74
      ],
      "accounts": [
        {
          "name": "referral",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  102,
                  101,
                  114,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "player"
              }
            ]
          }
        },
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "referrer",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setRoomKey",
      "discriminator": [
        56,
        114,
        114,
        219,
        77,
        130,
        6,
        239
      ],
      "accounts": [
        {
          "name": "guard",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  97,
                  114,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "program",
          "address": "Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "roomKey",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settleSigned",
      "discriminator": [
        63,
        57,
        208,
        72,
        206,
        78,
        1,
        171
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "guard",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  117,
                  97,
                  114,
                  100
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "matchAccount"
              }
            ]
          }
        },
        {
          "name": "mint",
          "relations": [
            "config"
          ]
        },
        {
          "name": "feeAta",
          "docs": [
            "The fee can go to one place: a token account owned by the match's",
            "fee wallet. The authority cannot point it anywhere else."
          ],
          "writable": true
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "instructions",
          "docs": [
            "room server's signature check."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "start",
      "discriminator": [
        62,
        15,
        117,
        236,
        47,
        1,
        89,
        139
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "matchAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "arg",
                "path": "id"
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                  95,
                  118,
                  50
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true
        },
        {
          "name": "program",
          "address": "Ctu4Q9hJKUksKZ9mXrydtua2LcuvmM8Wt34Xc6VK1wmj"
        },
        {
          "name": "programData"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "minPlayers",
          "type": {
            "option": "u8"
          }
        },
        {
          "name": "refundDelay",
          "type": {
            "option": "i64"
          }
        },
        {
          "name": "feeWallet",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "admission",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "guard",
      "discriminator": [
        54,
        187,
        84,
        137,
        192,
        15,
        74,
        248
      ]
    },
    {
      "name": "match",
      "discriminator": [
        236,
        63,
        169,
        38,
        15,
        56,
        196,
        162
      ]
    },
    {
      "name": "referral",
      "discriminator": [
        30,
        235,
        136,
        224,
        106,
        107,
        49,
        64
      ]
    }
  ],
  "events": [
    {
      "name": "authorityAccepted",
      "discriminator": [
        166,
        192,
        219,
        188,
        41,
        209,
        195,
        26
      ]
    },
    {
      "name": "authorityProposed",
      "discriminator": [
        244,
        117,
        94,
        112,
        53,
        151,
        35,
        89
      ]
    },
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "configUpdated",
      "discriminator": [
        40,
        241,
        230,
        122,
        11,
        19,
        198,
        194
      ]
    },
    {
      "name": "matchCancelled",
      "discriminator": [
        99,
        86,
        22,
        122,
        82,
        247,
        60,
        113
      ]
    },
    {
      "name": "matchClosed",
      "discriminator": [
        230,
        66,
        193,
        250,
        30,
        97,
        94,
        247
      ]
    },
    {
      "name": "matchCreated",
      "discriminator": [
        151,
        176,
        11,
        24,
        34,
        225,
        227,
        16
      ]
    },
    {
      "name": "matchSettled",
      "discriminator": [
        243,
        201,
        134,
        151,
        193,
        131,
        223,
        150
      ]
    },
    {
      "name": "matchStarted",
      "discriminator": [
        69,
        179,
        169,
        249,
        67,
        123,
        163,
        173
      ]
    },
    {
      "name": "playerEvicted",
      "discriminator": [
        55,
        85,
        189,
        184,
        72,
        215,
        202,
        247
      ]
    },
    {
      "name": "playerJoined",
      "discriminator": [
        39,
        144,
        49,
        106,
        108,
        210,
        183,
        38
      ]
    },
    {
      "name": "playerLeft",
      "discriminator": [
        7,
        106,
        62,
        150,
        175,
        170,
        96,
        84
      ]
    },
    {
      "name": "referralRecorded",
      "discriminator": [
        128,
        33,
        88,
        93,
        58,
        242,
        121,
        168
      ]
    },
    {
      "name": "roomKeySet",
      "discriminator": [
        28,
        226,
        200,
        138,
        193,
        224,
        157,
        15
      ]
    },
    {
      "name": "stakeRefunded",
      "discriminator": [
        81,
        188,
        224,
        106,
        3,
        59,
        199,
        216
      ]
    },
    {
      "name": "stakesCollected",
      "discriminator": [
        118,
        103,
        8,
        153,
        122,
        4,
        110,
        61
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "feeTooHigh",
      "msg": "Fee exceeds the ceiling"
    },
    {
      "code": 6001,
      "name": "badMinPlayers",
      "msg": "min_players must be between 1 and MAX_PLAYERS"
    },
    {
      "code": 6002,
      "name": "badRefundDelay",
      "msg": "refund_delay must be at least two seconds and at most seven days"
    },
    {
      "code": 6003,
      "name": "badEntry",
      "msg": "Entry must be positive"
    },
    {
      "code": 6004,
      "name": "matchNotOpen",
      "msg": "Match is not open"
    },
    {
      "code": 6005,
      "name": "matchFull",
      "msg": "Match is full"
    },
    {
      "code": 6006,
      "name": "alreadyJoined",
      "msg": "Already in this match"
    },
    {
      "code": 6007,
      "name": "notInMatch",
      "msg": "Not in this match"
    },
    {
      "code": 6008,
      "name": "insufficientFunds",
      "msg": "Token account does not hold the entry"
    },
    {
      "code": 6009,
      "name": "wrongMint",
      "msg": "Wrong mint"
    },
    {
      "code": 6010,
      "name": "tooFewPlayers",
      "msg": "Too few stakes collected to start"
    },
    {
      "code": 6011,
      "name": "matchNotCollected",
      "msg": "Match has not been collected"
    },
    {
      "code": 6012,
      "name": "badPodium",
      "msg": "Podium must contain min(3, collected_count) distinct stakers with matching token accounts"
    },
    {
      "code": 6013,
      "name": "notAStaker",
      "msg": "Not a staker in this match"
    },
    {
      "code": 6014,
      "name": "wrongFeeAccount",
      "msg": "Fee account is not owned by the fee wallet"
    },
    {
      "code": 6015,
      "name": "refundNotOpen",
      "msg": "Refund is not open yet"
    },
    {
      "code": 6016,
      "name": "vaultNotEmpty",
      "msg": "Vault still holds funds"
    },
    {
      "code": 6017,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6018,
      "name": "badReferrers",
      "msg": "Referrers must fit the podium and have matching token accounts"
    },
    {
      "code": 6019,
      "name": "referralExceedsFee",
      "msg": "Referral total exceeds the match fee"
    },
    {
      "code": 6020,
      "name": "deadlineExpired",
      "msg": "The refund deadline has expired"
    },
    {
      "code": 6021,
      "name": "wrongAdmission",
      "msg": "Admission signer does not match the config"
    },
    {
      "code": 6022,
      "name": "cannotEvict",
      "msg": "Only a Joined seat can be evicted"
    },
    {
      "code": 6023,
      "name": "wrongTokenAccount",
      "msg": "Token account does not match the joined source"
    },
    {
      "code": 6024,
      "name": "invalidAuthority",
      "msg": "Proposed authority must be a new nonzero key"
    },
    {
      "code": 6025,
      "name": "wrongPendingAuthority",
      "msg": "Signer is not the pending authority"
    },
    {
      "code": 6026,
      "name": "notUpgradeAuthority",
      "msg": "Only the program's upgrade authority can do this"
    },
    {
      "code": 6027,
      "name": "roomKeyNotSet",
      "msg": "The room server's key is not set"
    },
    {
      "code": 6028,
      "name": "missingRoomSignature",
      "msg": "A payout needs the room server's signature on its ranking"
    },
    {
      "code": 6029,
      "name": "badRoomSignature",
      "msg": "The signature check is not the room server's, or not for this ranking"
    },
    {
      "code": 6030,
      "name": "badRanking",
      "msg": "The ranking must hold one to six distinct wallets"
    },
    {
      "code": 6031,
      "name": "badReferral",
      "msg": "A referral must be a winner's own record, paid to its referrer"
    },
    {
      "code": 6032,
      "name": "tooSoon",
      "msg": "A payout cannot come in the second its match started"
    }
  ],
  "types": [
    {
      "name": "authorityAccepted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previousAuthority",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "authorityProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "pendingAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Signs match management; rotation requires the next key to accept."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingAuthority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "admission",
            "docs": [
              "Platform signer that admits players from the room roster."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeWallet",
            "docs": [
              "Owner of the token account the fee is paid to."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "minPlayers",
            "type": "u8"
          },
          {
            "name": "refundDelay",
            "docs": [
              "Seconds after first collection before refunds open."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "admission",
            "type": "pubkey"
          },
          {
            "name": "feeWallet",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "minPlayers",
            "type": "u8"
          },
          {
            "name": "refundDelay",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "configUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "admission",
            "type": "pubkey"
          },
          {
            "name": "feeWallet",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "minPlayers",
            "type": "u8"
          },
          {
            "name": "refundDelay",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "guard",
      "docs": [
        "The room server's Ed25519 key. Set only by the program's upgrade",
        "authority; every payout must carry the room server's signature over its",
        "ranking, so the payout key alone cannot choose who is paid."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roomKey",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "match",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "entry",
            "docs": [
              "Entry fee in the mint's base units."
            ],
            "type": "u64"
          },
          {
            "name": "feeBps",
            "docs": [
              "Pin the fee so config changes cannot reprice an open room."
            ],
            "type": "u16"
          },
          {
            "name": "feeWallet",
            "type": "pubkey"
          },
          {
            "name": "minPlayers",
            "type": "u8"
          },
          {
            "name": "refundDelay",
            "type": "i64"
          },
          {
            "name": "refundAfter",
            "docs": [
              "Pin the fire exit on first collection; zero before money moves."
            ],
            "type": "i64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "matchState"
              }
            }
          },
          {
            "name": "collectedAt",
            "docs": [
              "Unix time of `start`; zero until then."
            ],
            "type": "i64"
          },
          {
            "name": "pool",
            "docs": [
              "What the vault holds that has not been paid or refunded."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "players",
            "type": {
              "vec": {
                "defined": {
                  "name": "player"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "matchCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "entry",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "pool",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "winners",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "amounts",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "referrers",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "referralAmounts",
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "platformFee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchStarted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "stakers",
            "type": "u8"
          },
          {
            "name": "pool",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "collected"
          },
          {
            "name": "settled"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "player",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "playerStatus"
              }
            }
          }
        ]
      }
    },
    {
      "name": "playerEvicted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "seats",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "playerJoined",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "seats",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "playerLeft",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "seats",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "playerStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "joined"
          },
          {
            "name": "collected"
          },
          {
            "name": "dropped"
          },
          {
            "name": "paid"
          },
          {
            "name": "refunded"
          }
        ]
      }
    },
    {
      "name": "referral",
      "docs": [
        "Who invited this player. Written once: by the player, or by the upgrade",
        "authority for invites made before this record existed. A payout can pay",
        "only the referrer recorded here."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "referrer",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "referralRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "referrer",
            "type": "pubkey"
          },
          {
            "name": "byPlayer",
            "docs": [
              "Signed by the player; false when carried over by the upgrade authority."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roomKeySet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roomKey",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "stakeRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "player",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "stakesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "collected",
            "type": "u8"
          },
          {
            "name": "dropped",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103, 95, 118, 50]"
    },
    {
      "name": "guardSeed",
      "docs": [
        "The room server's key, which a payout needs a signature from."
      ],
      "type": "bytes",
      "value": "[103, 117, 97, 114, 100]"
    },
    {
      "name": "matchSeed",
      "type": "bytes",
      "value": "[109, 97, 116, 99, 104, 95, 118, 50]"
    },
    {
      "name": "maxFeeBps",
      "docs": [
        "Fee ceiling, in basis points. A config that asks for more is refused; the",
        "product's own setting is in the config (1000 since 2026-10-08)."
      ],
      "type": "u16",
      "value": "2000"
    },
    {
      "name": "maxPlayers",
      "docs": [
        "Seats in a room. The client's roster cap is 40; this leaves headroom",
        "without changing the account size later."
      ],
      "type": "u8",
      "value": "50"
    },
    {
      "name": "referralSeed",
      "docs": [
        "Who invited a player: one record per player, written once."
      ],
      "type": "bytes",
      "value": "[114, 101, 102, 101, 114, 114, 97, 108]"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
