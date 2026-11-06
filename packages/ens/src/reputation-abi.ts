export const DuskReputationAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "controller",
        "type": "address",
        "internalType": "contract DuskIdentityController"
      },
      {
        "name": "sources",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "AUTOMATIC_REASON",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CONTROLLER",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract DuskIdentityController"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "MAX_BATCH",
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
    "name": "PARENT_NODE",
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
    "name": "SCORE_POLICY_VERSION",
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
    "name": "acceptCompany",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "badAnswersOf",
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
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "commitOperatorName",
    "inputs": [
      {
        "name": "commitment",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "company",
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
    "name": "configurePolicy",
    "inputs": [
      {
        "name": "below",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "minimum",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "age",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "sources",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "configureWorkflow",
    "inputs": [
      {
        "name": "forwarder_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "owner_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "id_",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "dismissFinding",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "kind",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "decisionId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "evaluationState",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "jobs",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [
      {
        "name": "badAnswers",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "illegal",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "flags",
        "type": "uint8[]",
        "internalType": "uint8[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "findingFlagsOf",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "jobs",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "outputs": [
      {
        "name": "flags",
        "type": "uint8[]",
        "internalType": "uint8[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "forwarder",
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
    "name": "illegalOf",
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
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "maxReportAge",
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
    "name": "minimumResolved",
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
    "name": "onERC1155BatchReceived",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "onERC1155Received",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "from",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "value",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "onReport",
    "inputs": [
      {
        "name": "metadata",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "report",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paused",
    "inputs": [],
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
    "name": "pendingCompany",
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
    "name": "policyEpoch",
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
    "name": "processEvaluation",
    "inputs": [
      {
        "name": "e",
        "type": "tuple",
        "internalType": "struct DuskReputation.Evaluation",
        "components": [
          {
            "name": "wallet",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "generation",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "score",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "settledJobs",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "rejectedJobs",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "badAnswers",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "illegal",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "policyVersion",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "evaluatedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "galileoBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "arkivBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceRef",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "findings",
            "type": "tuple[]",
            "internalType": "struct DuskReputation.Finding[]",
            "components": [
              {
                "name": "job",
                "type": "bytes32",
                "internalType": "bytes32"
              },
              {
                "name": "kind",
                "type": "uint8",
                "internalType": "uint8"
              }
            ]
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "proposeCompany",
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
    "name": "publicationSequence",
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
    "name": "registerOperatorName",
    "inputs": [
      {
        "name": "secret",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "renewOperatorName",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "reputationOf",
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
        "type": "tuple",
        "internalType": "struct DuskReputation.Reputation",
        "components": [
          {
            "name": "score",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "standing",
            "type": "uint8",
            "internalType": "enum DuskReputation.Standing"
          },
          {
            "name": "policyVersion",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "policyEpoch",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "generation",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "sequence",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "evaluatedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "publishedAtBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "galileoBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "arkivBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "resolvedJobs",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "badAnswers",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "illegal",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "namehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "sourceContextHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceRef",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revokeBelow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "setPaused",
    "inputs": [
      {
        "name": "value",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sourceContextHash",
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
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "id",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "workflowId",
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
    "name": "workflowOwner",
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
    "type": "event",
    "name": "AutomaticallyRevoked",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sequence",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "decisionId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CompanyProposed",
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
    "name": "CompanyTransferred",
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
    "name": "EvaluationRejected",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "reason",
        "type": "bytes4",
        "indexed": false,
        "internalType": "bytes4"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FindingDismissed",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "decisionId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
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
    "name": "FindingRecorded",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "job",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "kind",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "evidenceHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PausedSet",
    "inputs": [
      {
        "name": "paused",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
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
    "name": "PolicyConfigured",
    "inputs": [
      {
        "name": "revokeBelow",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "minimumResolved",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "maxReportAge",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "sourceContextHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
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
    "name": "ReputationPublished",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "namehash",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "generation",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "label",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "reputation",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct DuskReputation.Reputation",
        "components": [
          {
            "name": "score",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "standing",
            "type": "uint8",
            "internalType": "enum DuskReputation.Standing"
          },
          {
            "name": "policyVersion",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "policyEpoch",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "generation",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "sequence",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "evaluatedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "publishedAtBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "galileoBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "arkivBlock",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "resolvedJobs",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "badAnswers",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "illegal",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "namehash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "sourceContextHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceRef",
            "type": "bytes32",
            "internalType": "bytes32"
          }
        ]
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RevocationDeferred",
    "inputs": [
      {
        "name": "wallet",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "sequence",
        "type": "uint64",
        "indexed": true,
        "internalType": "uint64"
      },
      {
        "name": "reason",
        "type": "bytes4",
        "indexed": false,
        "internalType": "bytes4"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "WorkflowConfigured",
    "inputs": [
      {
        "name": "forwarder",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "workflowOwner",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "workflowId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
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
    "type": "error",
    "name": "InvalidConfiguration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidEvaluation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotCompany",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotPendingCompany",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSelf",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Paused",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleEvaluation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StaleGeneration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UntrustedReport",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongDomain",
    "inputs": []
  }
] as const
