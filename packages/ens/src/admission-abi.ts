export const DuskAdmissionAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "sourceChainId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "controller",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "maxValidity",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "governance_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "attesters",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "quorum_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "CONTROLLER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_VALIDITY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SOURCE_CHAIN_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "STATUS_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptGovernance",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "attesterCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bumpEpoch",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "epoch",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "governance",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAdmitted",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAttester",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingGovernance",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "proposeGovernance",
    "inputs": [
      {
        "name": "next",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "quorum",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "records",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "admitted",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "sourceBlock",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "validUntil",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "epoch",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "resetRecord",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setAttester",
    "inputs": [
      {
        "name": "attester",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setQuorum",
    "inputs": [
      {
        "name": "quorum_",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "statusDigest",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct DuskAdmission.Status",
        "components": [
          {
            "name": "sourceChainId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "controller",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "wallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "admitted",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "sourceBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "epoch",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "submit",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct DuskAdmission.Status",
        "components": [
          {
            "name": "sourceChainId",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "controller",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "wallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "admitted",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "sourceBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "epoch",
            "type": "uint32",
            "internalType": "uint32"
          }
        ]
      },
      {
        "name": "signatures",
        "type": "bytes[]",
        "internalType": "bytes[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AttesterSet",
    "inputs": [
      {
        "name": "attester",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "allowed",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "EpochBumped",
    "inputs": [
      {
        "name": "epoch",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GovernanceProposed",
    "inputs": [
      {
        "name": "next",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GovernanceTransferred",
    "inputs": [
      {
        "name": "previous",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "next",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "QuorumSet",
    "inputs": [
      {
        "name": "quorum",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RecordReset",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "StatusUpdated",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "admitted",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "sourceBlock",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "validUntil",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "epoch",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "submitter",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadQuorum",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadValidity",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotGovernance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPendingGovernance",
    "inputs": []
  },
  {
    "type": "error",
    "name": "QuorumNotMet",
    "inputs": [
      {
        "name": "have",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "need",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "SignersNotSorted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleStatus",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownAttester",
    "inputs": [
      {
        "name": "signer",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "WrongEpoch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongSource",
    "inputs": []
  }
] as const
