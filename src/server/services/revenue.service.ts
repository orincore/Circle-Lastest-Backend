import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'

export interface RevenueStats {
  totalRevenue: number
  monthlyRevenue: number
  yearlyRevenue: number
  totalRefunds: number
  netRevenue: number
  revenueGrowth: number
  refundRate: number
}

export interface PlanRevenue {
  plan_type: string
  revenue: number
  subscribers: number
  averageRevenue: number
  refunds: number
  netRevenue: number
}

export interface MonthlyRevenueData {
  month: string
  revenue: number
  refunds: number
  netRevenue: number
  subscribers: number
}

export interface RevenueBreakdown {
  newSubscriptions: number
  renewals: number
  upgrades: number
  downgrades: number
  cancellations: number
  refunds: number
}

export class RevenueService {
  // Get overall revenue statistics
  static async getRevenueStats(days: number = 30): Promise<RevenueStats> {
    try {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)

      // Get subscription revenue
      const { data: subscriptions, error: subError } = await supabase
        .from('subscriptions')
        .select('price_paid, currency, started_at, plan_type')
        .gte('started_at', startDate.toISOString())
        .not('price_paid', 'is', null)

      if (subError) {
        logger.error({ error: subError }, 'Error fetching subscription revenue')
        throw subError
      }

      // Get refund data
      const { data: refunds, error: refundError } = await supabase
        .from('refunds')
        .select('amount, currency, requested_at, status')
        .gte('requested_at', startDate.toISOString())
        .in('status', ['approved', 'processed'])

      if (refundError) {
        logger.error({ error: refundError }, 'Error fetching refund data')
        throw refundError
      }

      // Calculate totals
      const totalRevenue = subscriptions?.reduce((sum, sub) => sum + (sub.price_paid || 0), 0) || 0
      const totalRefunds = refunds?.reduce((sum, refund) => sum + refund.amount, 0) || 0
      const netRevenue = totalRevenue - totalRefunds

      // Get previous period for growth calculation
      const prevStartDate = new Date(startDate)
      prevStartDate.setDate(prevStartDate.getDate() - days)

      const { data: prevSubscriptions } = await supabase
        .from('subscriptions')
        .select('price_paid')
        .gte('started_at', prevStartDate.toISOString())
        .lt('started_at', startDate.toISOString())
        .not('price_paid', 'is', null)

      const prevRevenue = prevSubscriptions?.reduce((sum, sub) => sum + (sub.price_paid || 0), 0) || 0
      const revenueGrowth = prevRevenue > 0 ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : 0

      // Calculate refund rate
      const refundRate = totalRevenue > 0 ? (totalRefunds / totalRevenue) * 100 : 0

      // Get monthly and yearly revenue
      const monthlyStartDate = new Date()
      monthlyStartDate.setMonth(monthlyStartDate.getMonth() - 1)

      const { data: monthlySubscriptions } = await supabase
        .from('subscriptions')
        .select('price_paid')
        .gte('started_at', monthlyStartDate.toISOString())
        .not('price_paid', 'is', null)

      const monthlyRevenue = monthlySubscriptions?.reduce((sum, sub) => sum + (sub.price_paid || 0), 0) || 0

      const yearlyStartDate = new Date()
      yearlyStartDate.setFullYear(yearlyStartDate.getFullYear() - 1)

      const { data: yearlySubscriptions } = await supabase
        .from('subscriptions')
        .select('price_paid')
        .gte('started_at', yearlyStartDate.toISOString())
        .not('price_paid', 'is', null)

      const yearlyRevenue = yearlySubscriptions?.reduce((sum, sub) => sum + (sub.price_paid || 0), 0) || 0

      return {
        totalRevenue,
        monthlyRevenue,
        yearlyRevenue,
        totalRefunds,
        netRevenue,
        revenueGrowth,
        refundRate
      }
    } catch (error) {
      logger.error({ error }, 'Error calculating revenue stats')
      throw error
    }
  }

  // Get revenue breakdown by plan type
  static async getRevenueByPlan(days: number = 30): Promise<PlanRevenue[]> {
    try {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)

      // Get subscription revenue by plan
      const { data: subscriptions, error: subError } = await supabase
        .from('subscriptions')
        .select('price_paid, currency, plan_type, user_id')
        .gte('started_at', startDate.toISOString())
        .not('price_paid', 'is', null)

      if (subError) throw subError

      // Get refunds by plan
      const { data: refunds, error: refundError } = await supabase
        .from('refunds')
        .select(`
          amount,
          subscription:subscriptions!inner(plan_type)
        `)
        .gte('requested_at', startDate.toISOString())
        .in('status', ['approved', 'processed'])

      if (refundError) throw refundError

      // Group by plan type
      const planData: { [key: string]: PlanRevenue } = {}

      // Process subscriptions
      subscriptions?.forEach(sub => {
        const planType = sub.plan_type || 'unknown'
        if (!planData[planType]) {
          planData[planType] = {
            plan_type: planType,
            revenue: 0,
            subscribers: 0,
            averageRevenue: 0,
            refunds: 0,
            netRevenue: 0
          }
        }
        planData[planType].revenue += sub.price_paid || 0
        planData[planType].subscribers += 1
      })

      // Process refunds
      refunds?.forEach((refund: any) => {
        const planType = refund.subscription?.plan_type || 'unknown'
        if (planData[planType]) {
          planData[planType].refunds += refund.amount
        }
      })

      // Calculate averages and net revenue
      Object.values(planData).forEach(plan => {
        plan.averageRevenue = plan.subscribers > 0 ? plan.revenue / plan.subscribers : 0
        plan.netRevenue = plan.revenue - plan.refunds
      })

      return Object.values(planData)
    } catch (error) {
      logger.error({ error }, 'Error calculating revenue by plan')
      throw error
    }
  }

  // Get monthly revenue trend
  static async getMonthlyRevenueTrend(months: number = 12): Promise<MonthlyRevenueData[]> {
    try {
      const monthlyData: MonthlyRevenueData[] = []
      
      for (let i = months - 1; i >= 0; i--) {
        const startDate = new Date()
        startDate.setMonth(startDate.getMonth() - i)
        startDate.setDate(1)
        startDate.setHours(0, 0, 0, 0)

        const endDate = new Date(startDate)
        endDate.setMonth(endDate.getMonth() + 1)

        // Get subscriptions for this month
        const { data: subscriptions } = await supabase
          .from('subscriptions')
          .select('price_paid, user_id')
          .gte('started_at', startDate.toISOString())
          .lt('started_at', endDate.toISOString())
          .not('price_paid', 'is', null)

        // Get refunds for this month
        const { data: refunds } = await supabase
          .from('refunds')
          .select('amount')
          .gte('requested_at', startDate.toISOString())
          .lt('requested_at', endDate.toISOString())
          .in('status', ['approved', 'processed'])

        const revenue = subscriptions?.reduce((sum, sub) => sum + (sub.price_paid || 0), 0) || 0
        const refundAmount = refunds?.reduce((sum, refund) => sum + refund.amount, 0) || 0
        const subscribers = subscriptions?.length || 0

        monthlyData.push({
          month: startDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short' }),
          revenue,
          refunds: refundAmount,
          netRevenue: revenue - refundAmount,
          subscribers
        })
      }

      return monthlyData
    } catch (error) {
      logger.error({ error }, 'Error calculating monthly revenue trend')
      throw error
    }
  }

  // Get detailed revenue breakdown
  static async getRevenueBreakdown(days: number = 30): Promise<RevenueBreakdown> {
    try {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)

      // Get all subscriptions in the period
      const { data: subscriptions } = await supabase
        .from('subscriptions')
        .select('price_paid, started_at, status, plan_type, user_id')
        .gte('started_at', startDate.toISOString())

      // Get refunds
      const { data: refunds } = await supabase
        .from('refunds')
        .select('amount')
        .gte('requested_at', startDate.toISOString())
        .in('status', ['approved', 'processed'])

      // Get cancellations
      const { data: cancellations } = await supabase
        .from('subscriptions')
        .select('price_paid')
        .gte('cancelled_at', startDate.toISOString())
        .not('cancelled_at', 'is', null)

      // Calculate breakdown (simplified logic - can be enhanced)
      const newSubscriptions = subscriptions?.filter(sub => sub.status === 'active').length || 0
      const renewals = 0 // Would need renewal tracking
      const upgrades = 0 // Would need plan change tracking
      const downgrades = 0 // Would need plan change tracking
      const cancellationCount = cancellations?.length || 0
      const refundAmount = refunds?.reduce((sum, refund) => sum + refund.amount, 0) || 0

      return {
        newSubscriptions,
        renewals,
        upgrades,
        downgrades,
        cancellations: cancellationCount,
        refunds: refundAmount
      }
    } catch (error) {
      logger.error({ error }, 'Error calculating revenue breakdown')
      throw error
    }
  }
}
