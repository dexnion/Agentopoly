export interface communityChestSchema {
  id: number;
  type:
    | 'movement'
    | 'movement_penalty'
    | 'movement_jail'
    | 'special'
    | 'financial'
    | 'financial_penalty';
  name: string;
  description: string;
  attributes?: {
    amount?: number;
    location?: number;
    jailFreeCard?: boolean;
    collectFromPlayers?: boolean;
    payToPlayers?: boolean;
    perPlayer?: number;
    moveSpaces?: number;
    moveToNearest?: 'railroad' | 'utility';
    rentMultiplier?: number;
    diceMultiplier?: number;
    perHouse?: number;
    perHotel?: number;
    collectOnPassGo?: boolean;
  };
}

export interface chanceSchema {
  id: number;
  type:
    | 'movement'
    | 'movement_penalty'
    | 'movement_jail'
    | 'special'
    | 'financial'
    | 'financial_penalty';
  name: string;
  description: string;
  attributes?: {
    amount?: number;
    location?: number;
    jailFreeCard?: boolean;
    collectFromPlayers?: boolean;
    payToPlayers?: boolean;
    perPlayer?: number;
    moveSpaces?: number;
    moveToNearest?: 'railroad' | 'utility';
    rentMultiplier?: number;
    diceMultiplier?: number;
    perHouse?: number;
    perHotel?: number;
    collectOnPassGo?: boolean;
  };
}

// NOTE: Board indices in your board.ts:
// - Go = 0
// - Reading (Raily Railroad) = 5
// - St. Charles Place (Saint Charles Square) = 16
// - Illinois Avenue (Illinois Lane) = 24
// - Jail = 10
// - Boardwalk (Boardwalk Empire) = 39

export const chance: chanceSchema[] = [
  {
    id: 1,
    type: 'movement',
    name: 'Advance to Boardwalk',
    description: 'Advance to Boardwalk.',
    attributes: {
      location: 39,
    },
  },
  {
    id: 2,
    type: 'movement',
    name: 'Advance to Go',
    description: 'Advance to Go (Collect $200).',
    attributes: {
      location: 0,
      amount: 200,
    },
  },
  {
    id: 3,
    type: 'movement',
    name: 'Advance to Illinois Avenue',
    description:
      'Advance to Illinois Avenue. If you pass Go, collect $200.',
    attributes: {
      location: 24,
      collectOnPassGo: true,
    },
  },
  {
    id: 4,
    type: 'movement',
    name: 'Advance to St. Charles Place',
    description:
      'Advance to St. Charles Place. If you pass Go, collect $200.',
    attributes: {
      location: 16,
      collectOnPassGo: true,
    },
  },
  {
    id: 5,
    type: 'movement',
    name: 'Advance to Nearest Railroad',
    description:
      'Advance to the nearest Railroad. If unowned, you may buy it from the Bank. If owned, pay twice the rental.',
    attributes: {
      moveToNearest: 'railroad',
      rentMultiplier: 2,
    },
  },
  {
    id: 6,
    type: 'movement',
    name: 'Advance to Nearest Railroad',
    description:
      'Advance to the nearest Railroad. If unowned, you may buy it from the Bank. If owned, pay twice the rental.',
    attributes: {
      moveToNearest: 'railroad',
      rentMultiplier: 2,
    },
  },
  {
    id: 7,
    type: 'movement',
    name: 'Advance Token to Nearest Utility',
    description:
      'Advance token to nearest Utility. If unowned, you may buy it. If owned, throw dice and pay 10x the amount thrown.',
    attributes: {
      moveToNearest: 'utility',
      diceMultiplier: 10,
    },
  },
  {
    id: 8,
    type: 'financial',
    name: 'Bank Pays You Dividend',
    description: 'Bank pays you dividend of $50.',
    attributes: {
      amount: 50,
    },
  },
  {
    id: 9,
    type: 'special',
    name: 'Get Out of Jail Free',
    description:
      'Get Out of Jail Free. This card may be kept until needed or sold.',
    attributes: {
      jailFreeCard: true,
    },
  },
  {
    id: 10,
    type: 'movement_penalty',
    name: 'Go Back 3 Spaces',
    description: 'Go back 3 spaces.',
    attributes: {
      moveSpaces: -3,
    },
  },
  {
    id: 11,
    type: 'movement_jail',
    name: 'Go to Jail',
    description:
      'Go to Jail. Go directly to Jail, do not pass Go, do not collect $200.',
    attributes: {
      location: 10,
    },
  },
  {
    id: 12,
    type: 'financial_penalty',
    name: 'Make General Repairs',
    description:
      'Make general repairs on all your property. For each house pay $25. For each hotel pay $100.',
    attributes: {
      perHouse: 25,
      perHotel: 100,
    },
  },
  {
    id: 13,
    type: 'financial_penalty',
    name: 'Speeding Fine',
    description: 'Speeding fine $15.',
    attributes: {
      amount: -15,
    },
  },
  {
    id: 14,
    type: 'movement',
    name: 'Take a Trip to Reading Railroad',
    description:
      'Take a trip to Reading Railroad. If you pass Go, collect $200.',
    attributes: {
      location: 5,
      collectOnPassGo: true,
    },
  },
  {
    id: 15,
    type: 'financial_penalty',
    name: 'Chairman of the Board',
    description:
      'You have been elected Chairman of the Board. Pay each player $50.',
    attributes: {
      payToPlayers: true,
      perPlayer: 50,
    },
  },
  {
    id: 16,
    type: 'financial',
    name: 'Building Loan Matures',
    description: 'Your building loan matures. Collect $150.',
    attributes: {
      amount: 150,
    },
  },
];

export const communityChest: communityChestSchema[] = [
  {
    id: 1,
    type: 'movement',
    name: 'Advance to Go',
    description: 'Advance to Go (Collect $200).',
    attributes: {
      location: 0,
      amount: 200,
    },
  },
  {
    id: 2,
    type: 'financial',
    name: 'Bank Error in Your Favor',
    description: 'Bank error in your favor. Collect $200.',
    attributes: {
      amount: 200,
    },
  },
  {
    id: 3,
    type: 'financial_penalty',
    name: 'Doctor’s Fee',
    description: 'Doctor’s fee. Pay $50.',
    attributes: {
      amount: -50,
    },
  },
  {
    id: 4,
    type: 'financial',
    name: 'From Sale of Stock',
    description: 'From sale of stock you get $50.',
    attributes: {
      amount: 50,
    },
  },
  {
    id: 5,
    type: 'special',
    name: 'Get Out of Jail Free',
    description:
      'Get Out of Jail Free. This card may be kept until needed or sold.',
    attributes: {
      jailFreeCard: true,
    },
  },
  {
    id: 6,
    type: 'movement_jail',
    name: 'Go to Jail',
    description:
      'Go to Jail. Go directly to jail, do not pass Go, do not collect $200.',
    attributes: {
      location: 10,
    },
  },
  {
    id: 7,
    type: 'financial',
    name: 'Holiday Fund Matures',
    description: 'Holiday fund matures. Receive $100.',
    attributes: {
      amount: 100,
    },
  },
  {
    id: 8,
    type: 'financial',
    name: 'Income Tax Refund',
    description: 'Income tax refund. Collect $20.',
    attributes: {
      amount: 20,
    },
  },
  {
    id: 9,
    type: 'financial',
    name: 'It Is Your Birthday',
    description: 'It is your birthday. Collect $10 from every player.',
    attributes: {
      collectFromPlayers: true,
      perPlayer: 10,
    },
  },
  {
    id: 10,
    type: 'financial',
    name: 'Life Insurance Matures',
    description: 'Life insurance matures. Collect $100.',
    attributes: {
      amount: 100,
    },
  },
  {
    id: 11,
    type: 'financial_penalty',
    name: 'Hospital Fees',
    description: 'Pay hospital fees of $100.',
    attributes: {
      amount: -100,
    },
  },
  {
    id: 12,
    type: 'financial_penalty',
    name: 'School Fees',
    description: 'Pay school fees of $50.',
    attributes: {
      amount: -50,
    },
  },
  {
    id: 13,
    type: 'financial',
    name: 'Consultancy Fee',
    description: 'Receive $25 consultancy fee.',
    attributes: {
      amount: 25,
    },
  },
  {
    id: 14,
    type: 'financial_penalty',
    name: 'Street Repair Assessment',
    description:
      'You are assessed for street repair. $40 per house. $115 per hotel.',
    attributes: {
      perHouse: 40,
      perHotel: 115,
    },
  },
  {
    id: 15,
    type: 'financial',
    name: 'Beauty Contest Prize',
    description:
      'You have won second prize in a beauty contest. Collect $10.',
    attributes: {
      amount: 10,
    },
  },
  {
    id: 16,
    type: 'financial',
    name: 'You Inherit $100',
    description: 'You inherit $100.',
    attributes: {
      amount: 100,
    },
  },
];
