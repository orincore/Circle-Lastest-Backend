import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm'
import { db } from '../config/db.js'
import { userSubscriptions, refunds } from '../db/schema.js'
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

const REFUNDED_STATUSES = ['approved', 'processed']

export class RevenueService {
  // Get overall revenue statistics
  static async getRevenueStats(days: number = 30): Promise<RevenueStats> {
    try {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)

      const subscriptions = await db.select({ amount: userSubscriptions.amount, startedAt: userSubscriptions.startedAt })
        .from(userSubscriptions)
        .where(and(gte(userSubscriptions.startedAt, startDate.toISOString()), isNotNull(userSubscriptions.amount)))

      const refundRows = await db.select({ amount: refunds.amount, requestedAt: refunds.requestedAt })
        .from(refunds)
        .where(and(gte(refunds.requestedAt, startDate.toISOString()), inArray(refunds.status, REFUNDED_STATUSES)))

      const totalRevenue = subscriptions.reduce((sum, sub) => sum + Number(sub.amount || 0), 0)
      const totalRefunds = refundRows.reduce((sum, refund) => sum + Number(refund.amount || 0), 0)
      const netRevenue = totalRevenue - totalRefunds

      const prevStartDate = new Date(startDate)
      prevStartDate.setDate(prevStartDate.getDate() - days)

      const prevSubscriptions = await db.select({ amount: userSubscriptions.amount })
        .from(userSubscriptions)
        .where(and(
          gte(userSubscriptions.startedAt, prevStartDate.toISOString()),
          lt(userSubscriptions.startedAt, startDate.toISOString()),
          isNotNull(userSubscriptions.amount),
        ))

      const prevRevenue = prevSubscriptions.reduce((sum, sub) => sum + Number(sub.amount || 0), 0)
      const revenueGrowth = prevRevenue > 0 ? ((totalRevenue - prevRevenue) / prevRevenue) * 100 : 0
      const refundRate = totalRevenue > 0 ? (totalRefunds / totalRevenue) * 100 : 0

      const monthlyStartDate = new Date()
      monthlyStartDate.setMonth(monthlyStartDate.getMonth() - 1)

      const monthlySubscriptions = await db.select({ amount: userSubscriptions.amount })
        .from(userSubscriptions)
        .where(and(gte(userSubscriptions.startedAt, monthlyStartDate.toISOString()), isNotNull(userSubscriptions.amount)))

      const monthlyRevenue = monthlySubscriptions.reduce((sum, sub) => sum + Number(sub.amount || 0), 0)

      const yearlyStartDate = new Date()
      yearlyStartDate.setFullYear(yearlyStartDate.getFullYear() - 1)

      const yearlySubscriptions = await db.select({ amount: userSubscriptions.amount })
        .from(userSubscriptions)
        .where(and(gte(userSubscriptions.startedAt, yearlyStartDate.toISOString()), isNotNull(userSubscriptions.amount)))

      const yearlyRevenue = yearlySubscriptions.reduce((sum, sub) => sum + Number(sub.amount || 0), 0)

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

      const subscriptions = await db.select({
        amount: userSubscriptions.amount,
        planId: userSubscriptions.planId,
      })
        .from(userSubscriptions)
        .where(and(gte(userSubscriptions.startedAt, startDate.toISOString()), isNotNull(userSubscriptions.amount)))

      const refundRows = await db.select({
        amount: refunds.amount,
        planId: userSubscriptions.planId,
      })
        .from(refunds)
        .leftJoin(userSubscriptions, eq(userSubscriptions.id, refunds.subscriptionId))
        .where(and(gte(refunds.requestedAt, startDate.toISOString()), inArray(refunds.status, REFUNDED_STATUSES)))

      const planData: { [key: string]: PlanRevenue } = {}

      subscriptions.forEach(sub => {
        const planType = sub.planId || 'unknown'
        if (!planData[planType]) {
          planData[planType] = { plan_type: planType, revenue: 0, subscribers: 0, averageRevenue: 0, refunds: 0, netRevenue: 0 }
        }
        planData[planType].revenue += Number(sub.amount || 0)
        planData[planType].subscribers += 1
      })

      refundRows.forEach(refund => {
        const planType = refund.planId || 'unknown'
        if (planData[planType]) {
          planData[planType].refunds += Number(refund.amount || 0)
        }
      })

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

        const subscriptions = await db.select({ amount: userSubscriptions.amount })
          .from(userSubscriptions)
          .where(and(
            gte(userSubscriptions.startedAt, startDate.toISOString()),
            lt(userSubscriptions.startedAt, endDate.toISOString()),
            isNotNull(userSubscriptions.amount),
          ))

        const refundRows = await db.select({ amount: refunds.amount })
          .from(refunds)
          .where(and(
            gte(refunds.requestedAt, startDate.toISOString()),
            lt(refunds.requestedAt, endDate.toISOString()),
            inArray(refunds.status, REFUNDED_STATUSES),
          ))

        const revenue = subscriptions.reduce((sum, sub) => sum + Number(sub.amount || 0), 0)
        const refundAmount = refundRows.reduce((sum, refund) => sum + Number(refund.amount || 0), 0)

        monthlyData.push({
          month: startDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short' }),
          revenue,
          refunds: refundAmount,
          netRevenue: revenue - refundAmount,
          subscribers: subscriptions.length
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

      const subscriptions = await db.select({ status: userSubscriptions.status })
        .from(userSubscriptions)
        .where(gte(userSubscriptions.startedAt, startDate.toISOString()))

      const refundRows = await db.select({ amount: refunds.amount })
        .from(refunds)
        .where(and(gte(refunds.requestedAt, startDate.toISOString()), inArray(refunds.status, REFUNDED_STATUSES)))

      const cancellations = await db.select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(and(gte(userSubscriptions.cancelledAt, startDate.toISOString()), isNotNull(userSubscriptions.cancelledAt)))

      const newSubscriptions = subscriptions.filter(sub => sub.status === 'active').length
      const refundAmount = refundRows.reduce((sum, refund) => sum + Number(refund.amount || 0), 0)

      return {
        newSubscriptions,
        renewals: 0, // Would need renewal tracking
        upgrades: 0, // Would need plan change tracking
        downgrades: 0, // Would need plan change tracking
        cancellations: cancellations.length,
        refunds: refundAmount
      }
    } catch (error) {
      logger.error({ error }, 'Error calculating revenue breakdown')
      throw error
    }
  }
}
