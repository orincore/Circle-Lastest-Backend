/**
 * Subscription Plans Configuration
 * Easy to modify pricing - just update the amounts here
 */

export interface SubscriptionPlan {
  id: string;
  name: string;
  duration: 'monthly' | 'yearly';
  price: number; // in INR
  currency: string;
  features: string[];
  popular?: boolean;
  savings?: string;
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'monthly',
    name: 'Monthly Plan',
    duration: 'monthly',
    price: 10, // ₹10/month - CHANGE THIS TO UPDATE PRICE
    currency: 'INR',
    features: [
      'Unlimited messaging',
      'Advanced matching',
      'See who liked you',
      'Priority support',
      'Ad-free experience'
    ],
    popular: false
  },
  {
    id: 'yearly',
    name: 'Yearly Plan',
    duration: 'yearly',
    price: 50, // ₹50/year - CHANGE THIS TO UPDATE PRICE
    currency: 'INR',
    features: [
      'All Monthly features',
      'Unlimited messaging',
      'Advanced matching',
      'See who liked you',
      'Priority support',
      'Ad-free experience',
      'Save ₹70 per year'
    ],
    popular: true,
    savings: 'Save 58%'
  }
];

// Helper function to get plan by ID
export const getPlanById = (planId: string): SubscriptionPlan | undefined => {
  return SUBSCRIPTION_PLANS.find(plan => plan.id === planId);
};

// Helper function to calculate savings
export const calculateSavings = (): number => {
  const monthly = SUBSCRIPTION_PLANS.find(p => p.id === 'monthly');
  const yearly = SUBSCRIPTION_PLANS.find(p => p.id === 'yearly');
  
  if (monthly && yearly) {
    return (monthly.price * 12) - yearly.price;
  }
  return 0;
};

// Helper to get duration in days
export const getDurationInDays = (planId: string): number => {
  const plan = getPlanById(planId);
  if (!plan) return 0;
  
  return plan.duration === 'monthly' ? 30 : 365;
};

export default SUBSCRIPTION_PLANS;
