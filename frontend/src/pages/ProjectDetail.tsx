import {useMemo, useEffect} from 'react'
import {useParams, useNavigate, useSearchParams, Link} from 'react-router-dom'
import {motion} from 'framer-motion'
import {useAppDispatch, useAppSelector} from '../utils/hooks'
import {archiveProject, hardDeleteProject} from '../store/slices/projectsSlice'
import {useProjectDetailState} from './ProjectDetail/hooks/useProjectDetailState'
import {useProjectDetailData} from './ProjectDetail/hooks/useProjectDetailData'
import {useProjectDetailHandlers} from './ProjectDetail/hooks/useProjectDetailHandlers'
import {useProjectDetailEffects} from './ProjectDetail/hooks/useProjectDetailEffects'
import ProjectTrendsChart from '../components/charts/ProjectTrendsChart'
import EditTransactionModal from '../components/EditTransactionModal'
import CreateTransactionModal from '../components/CreateTransactionModal'
import CreateProjectModal from '../components/CreateProjectModal'
import EditRecurringTemplateModal from '../components/EditRecurringTemplateModal'
import EditRecurringSelectionModal from '../components/EditRecurringSelectionModal'
import DeleteTransactionModal from '../components/DeleteTransactionModal'
import {formatDate} from '../lib/utils'
import {CATEGORY_LABELS} from '../utils/calculations'
import {Transaction} from './ProjectDetail/types'
import {PAYMENT_METHOD_LABELS} from './ProjectDetail/constants'
import FinancialSummary from './ProjectDetail/components/FinancialSummary'
import ProjectHeader from './ProjectDetail/components/ProjectHeader'
import TransactionsList from './ProjectDetail/components/TransactionsList'
import TransactionDetailsModal from './ProjectDetail/components/TransactionDetailsModal'
import BudgetsAndCharts from './ProjectDetail/components/BudgetsAndCharts'
import FundAndUnforeseenPanel from './ProjectDetail/components/FundAndUnforeseenPanel'
import ProjectNotesBoard from '../components/project-notes/ProjectNotesBoard'
import FundModals from './ProjectDetail/components/FundModals'
import DocumentsModals from './ProjectDetail/components/DocumentsModals'
import LoadingOverlay from './ProjectDetail/components/LoadingOverlay'
import HistoricalPeriodBanner from './ProjectDetail/components/HistoricalPeriodBanner'
import GlobalDateFilter from './ProjectDetail/components/GlobalDateFilter'
import SubprojectsList from './ProjectDetail/components/SubprojectsList'
import ContractViewerModal from './ProjectDetail/components/ContractViewerModal'
import ArchiveDeleteModal from './ProjectDetail/components/ArchiveDeleteModal'
import DeleteConfirmModal from './ProjectDetail/components/DeleteConfirmModal'
import CreateBudgetModal from './ProjectDetail/components/CreateBudgetModal'
import PreviousYearsModal from './ProjectDetail/components/PreviousYearsModal'
import ContractPeriodSummaryModal from './ProjectDetail/components/ContractPeriodSummaryModal'
import UnforeseenTransactionsModal from './ProjectDetail/components/UnforeseenTransactionsModal'
import CreateUnforeseenTransactionModal from './ProjectDetail/components/CreateUnforeseenTransactionModal'
import UnforeseenTransactionDetailsModal from './ProjectDetail/components/UnforeseenTransactionDetailsModal'
import MonthlyExpenseTable from './ProjectDetail/components/MonthlyExpenseTable'
import EditBudgetModal from './ProjectDetail/components/EditBudgetModal'
import DescriptionModal from './ProjectDetail/components/DescriptionModal'
import api from '../lib/api'
import { BudgetAPI, ProjectAPI, RecurringTransactionAPI, UnforeseenTransactionAPI } from '../lib/apiClient'

export default function ProjectDetail() {
    const {id} = useParams()
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()
    const periodIdParam = searchParams.get('period')
    const viewingPeriodId = periodIdParam ? parseInt(periodIdParam) : null
    const focusParam = searchParams.get('focus')
    const dispatch = useAppDispatch()
    const {items: suppliers} = useAppSelector(s => s.suppliers)
    const me = useAppSelector(s => s.auth.me)
    const isAdmin = me?.role === 'Admin'

    // Use custom hooks for state, data, handlers, and effects
    const state = useProjectDetailState()
    const dataLoaders = useProjectDetailData(id, viewingPeriodId, state, navigate)
    const handlers = useProjectDetailHandlers(id, viewingPeriodId, state, dataLoaders, navigate, dispatch)
    useProjectDetailEffects(id, viewingPeriodId, state, dataLoaders, dispatch, navigate, me)

    // Scroll to fund or transactions when coming from dashboard "עבור לתיקון"
    useEffect(() => {
        if (!focusParam || !state.loading) return
        const timer = setTimeout(() => {
            const el = document.getElementById(focusParam === 'fund' ? 'project-fund' : 'project-transactions')
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
            setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('focus'); return next }, { replace: true })
        }, 400)
        return () => clearTimeout(timer)
    }, [focusParam, state.loading, setSearchParams])

    // Legacy aliases for backward compatibility
    const dateFilterMode = state.globalDateFilterMode === 'project' ? 'all_time' : state.globalDateFilterMode
    const selectedMonth = state.globalSelectedMonth
    const startDate = state.globalStartDate
    const endDate = state.globalEndDate
    const setDateFilterMode = (mode: 'current_month' | 'selected_month' | 'date_range' | 'all_time') => state.setGlobalDateFilterMode(mode)
    const setSelectedMonth = state.setGlobalSelectedMonth
    const setStartDate = state.setGlobalStartDate
    const setEndDate = state.setGlobalEndDate

    // Calculate financial summary using handler
    const financialSummary = useMemo(() => {
        return handlers.calculateFinancialSummary()
    }, [state.txs, state.projectStartDate, state.projectEndDate, state.projectBudget, state.globalDateFilterMode, state.globalSelectedMonth, state.globalSelectedYear, state.globalStartDate, state.globalEndDate, state.firstContractStartDate, state.allPeriods])

    const income = financialSummary.income
    const expense = financialSummary.expense
    const contractViewerUrl = handlers.getContractViewerUrl()

    // Effective period for budgets: when viewing a specific period, use it; otherwise current
    const effectiveBudgetPeriodId = viewingPeriodId ?? state.selectedPeriod?.period_id ?? state.currentContractPeriod?.period_id ?? null

    // Additional computed values for JSX
    const allCategoryOptions = state.availableCategories
    const isViewingHistoricalPeriod = viewingPeriodId !== null && state.selectedPeriod !== null
    const totalPeriods = useMemo(() => {
        const previousPeriodsCount = state.contractPeriods?.periods_by_year
            ? state.contractPeriods.periods_by_year.reduce((sum: number, year: any) => sum + year.periods.length, 0)
            : 0;
        return previousPeriodsCount > 0 || (state.contractPeriods !== null && state.contractPeriods !== undefined) ? 1 : 0;
    }, [state.contractPeriods]);
    const firstContractStartDate = useMemo(() => {
        let min: string | null = null;
        if (state.currentContractPeriod?.start_date) {
            min = state.currentContractPeriod.start_date;
        }
        if (state.contractPeriods?.periods_by_year?.length) {
            for (const yearGroup of state.contractPeriods.periods_by_year) {
                for (const p of yearGroup.periods || []) {
                    if (p.start_date) {
                        if (!min || p.start_date < min) min = p.start_date;
                    }
                }
            }
        }
        return min;
    }, [state.contractPeriods, state.currentContractPeriod?.start_date]);
    const allPeriods = useMemo(() => {
        if (!state.contractPeriods?.periods_by_year) return [];
        return state.contractPeriods.periods_by_year
            .flatMap((yearGroup: any) => yearGroup.periods)
            .sort((a: any, b: any) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime());
    }, [state.contractPeriods]);
    const currentViewingPeriodIndex = useMemo(() => {
        if (!state.selectedPeriod || allPeriods.length === 0) return -1;
        return allPeriods.findIndex((p: any) => p.period_id === (state.selectedPeriod?.period_id || 0));
    }, [state.selectedPeriod, allPeriods]);
    const prevPeriod = currentViewingPeriodIndex > 0 ? allPeriods[currentViewingPeriodIndex - 1] : null;
    const nextPeriod = currentViewingPeriodIndex !== -1 && currentViewingPeriodIndex < allPeriods.length - 1
        ? allPeriods[currentViewingPeriodIndex + 1]
        : null;

    // Data loading, the parent-project redirect, the suppliers fetch, the contract-modal
    // reset and the `projectUpdated` listener all live in useProjectDetailEffects (called
    // above). They used to be duplicated here as well, which ran every one of them twice —
    // most visibly firing GET /projects/{id}/full and the unforeseen-transactions request
    // twice on every mount.

    // Early return if no id
    if (!id) {
        return (
            <div className="space-y-4">
                <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded">
                    מזהה פרויקט לא תקין
                </div>
                <button
                    onClick={() => navigate('/dashboard')}
                    className="bg-gray-900 text-white px-4 py-2 rounded"
                >
                    חזור לדשבורד
                </button>
            </div>
        )
    }

    // Don't render main content if redirecting to parent project route
    if (state.isParentProject && id && !isNaN(Number(id)) && !state.loading) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-center min-h-[400px]">
                    <div className="text-center">
                        <div
                            className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                        <p className="text-lg font-semibold text-gray-900 dark:text-white">
                            מעביר לדף פרויקט אב...
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    // Show error message if there was an error loading data
    if (state.error && !state.loading) {
        return (
            <div className="space-y-4">
                <div
                    className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 p-6 rounded-lg">
                    <h2 className="text-xl font-bold mb-2">שגיאה בטעינת הפרויקט</h2>
                    <p className="mb-4">{state.error}</p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => {
                                state.setError(null)
                                if (id && !isNaN(Number(id))) {
                                    dataLoaders.loadAllProjectData(viewingPeriodId)
                                }
                            }}
                            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors"
                        >
                            נסה שוב
                        </button>
                        <button
                            onClick={() => navigate('/dashboard')}
                            className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg transition-colors"
                        >
                            חזור לדשבורד
                        </button>
                    </div>
                </div>
            </div>
        )
    }



    const handleEditProject = async () => {
        if (!id || isNaN(Number(id))) return
        try {
            // Use the same API call that loadProjectInfo uses for consistency
            const {data} = await api.get(`/projects/${id}`)
            state.setEditingProject(data)
            state.setShowEditProjectModal(true)
        } catch (err: any) {
            alert('שגיאה בטעינת פרטי הפרויקט: ' + (err.response?.data?.detail || err.message))
        }
    }

    const handleProjectUpdateSuccess = async () => {
        await dataLoaders.loadProjectInfo()
        state.setShowEditProjectModal(false)
        state.setEditingProject(null)
    }

    const handleArchiveDeleteClick = () => {
        state.setShowArchiveDeleteModal(true)
    }

    const handleArchive = async () => {
        if (!id || isNaN(Number(id))) return
        try {
            await dispatch(archiveProject(Number(id))).unwrap()
            state.setShowArchiveDeleteModal(false)
            navigate('/projects')
        } catch (err: any) {
            alert('שגיאה בארכוב הפרויקט: ' + (err || 'Unknown error'))
        }
    }

    const handleDeleteChoice = () => {
        state.setShowArchiveDeleteModal(false)
        state.setShowDeleteConfirmModal(true)
    }

    const handleDeleteConfirm = async () => {
        if (!id || isNaN(Number(id))) return
        if (!state.deletePassword) {
            state.setDeletePasswordError('נא להזין סיסמה')
            return
        }

        state.setIsDeleting(true)
        state.setDeletePasswordError('')

        try {
            await dispatch(hardDeleteProject({id: Number(id), password: state.deletePassword})).unwrap()
            state.setShowDeleteConfirmModal(false)
            state.setDeletePassword('')
            navigate('/projects')
        } catch (err: any) {
            state.setDeletePasswordError(err || 'סיסמה שגויה או שגיאה במחיקה')
        } finally {
            state.setIsDeleting(false)
        }
    }

    const handleDeleteFund = async () => {
        if (!id || isNaN(Number(id))) return
        if (!state.deleteFundPassword) {
            state.setDeleteFundPasswordError('נא להזין סיסמה')
            return
        }
        state.setIsDeletingFund(true)
        state.setDeleteFundPasswordError('')
        try {
            await api.delete(`/projects/${id}/fund`, {
                data: { password: state.deleteFundPassword }
            })
            state.setShowDeleteFundModal(false)
            state.setDeleteFundPassword('')
            await dataLoaders.loadProjectInfo()
            await dataLoaders.loadFundData()
        } catch (err: any) {
            state.setDeleteFundPasswordError(err.response?.data?.detail || 'שגיאה במחיקת הקופה')
        } finally {
            state.setIsDeletingFund(false)
        }
    }

    const resetUnforeseenForm = () => {
        state.setUnforeseenIncomes([{amount: 0, description: '', documentFiles: [], incomeId: null, documentIds: []}])
        state.setUnforeseenDescription('')
        state.setUnforeseenNotes('')
        state.setUnforeseenTransactionDate(new Date().toISOString().split('T')[0])
        state.setUnforeseenExpenses([{amount: 0, description: '', documentFiles: [], expenseId: null, documentIds: []}])
        state.setEditingUnforeseenTransaction(null)
        state.setUploadingDocumentForExpense(null)
        state.setUploadingDocumentForIncome(null)
    }

    const handleAddUnforeseenExpense = () => {
        state.setUnforeseenExpenses([...state.unforeseenExpenses, {
            amount: 0,
            description: '',
            documentFiles: [],
            expenseId: null,
            documentIds: []
        }])
    }

    const handleRemoveUnforeseenExpense = (index: number) => {
        state.setUnforeseenExpenses(state.unforeseenExpenses.filter((_: any, i: number) => i !== index))
    }

    const handleUnforeseenExpenseChange = (index: number, field: 'amount' | 'description', value: string | number) => {
        const newExpenses = [...state.unforeseenExpenses]
        newExpenses[index] = {...newExpenses[index], [field]: value}
        state.setUnforeseenExpenses(newExpenses)
    }

    const handleUnforeseenExpenseDocumentChange = (index: number, files: FileList | null) => {
        if (!files) return
        const newExpenses = [...state.unforeseenExpenses]
        newExpenses[index] = {
            ...newExpenses[index], 
            documentFiles: [...newExpenses[index].documentFiles, ...Array.from(files)]
        }
        state.setUnforeseenExpenses(newExpenses)
    }

    const handleRemoveUnforeseenExpenseDocument = (expenseIndex: number, fileIndex: number) => {
        const newExpenses = [...state.unforeseenExpenses]
        newExpenses[expenseIndex] = {
            ...newExpenses[expenseIndex],
            documentFiles: newExpenses[expenseIndex].documentFiles.filter((_: any, i: number) => i !== fileIndex)
        }
        state.setUnforeseenExpenses(newExpenses)
    }

    const handleUnforeseenIncomeDocumentChange = (index: number, files: FileList | null) => {
        if (!files) return
        const newIncomes = [...state.unforeseenIncomes]
        newIncomes[index] = {
            ...newIncomes[index],
            documentFiles: [...newIncomes[index].documentFiles, ...Array.from(files)]
        }
        state.setUnforeseenIncomes(newIncomes)
    }

    const handleRemoveUnforeseenIncomeDocument = (incomeIndex: number, fileIndex: number) => {
        const newIncomes = [...state.unforeseenIncomes]
        newIncomes[incomeIndex] = {
            ...newIncomes[incomeIndex],
            documentFiles: newIncomes[incomeIndex].documentFiles.filter((_: any, i: number) => i !== fileIndex)
        }
        state.setUnforeseenIncomes(newIncomes)
    }

    const calculateUnforeseenProfitLoss = () => {
        const totalExpenses = state.unforeseenExpenses.reduce((sum: number, exp: any) => sum + (parseFloat(String(exp.amount)) || 0), 0)
        const totalIncomes = state.unforeseenIncomes.reduce((sum: number, inc: any) => sum + (parseFloat(String(inc.amount)) || 0), 0)
        const profitLoss = totalIncomes - totalExpenses
        return Math.round(profitLoss * 100) / 100
    }

    const calculateUnforeseenTotalExpenses = () => {
        const total = state.unforeseenExpenses.reduce((sum: number, exp: any) => sum + (parseFloat(String(exp.amount)) || 0), 0)
        return Math.round(total * 100) / 100
    }

    const roundTo2 = (n: number) => Math.round(n * 100) / 100

    const handleCreateUnforeseenTransaction = async (status: 'draft' | 'waiting_for_approval' = 'draft') => {
        if (!id) return
        state.setUnforeseenSubmitting(true)
        try {
            // Store expense/income files before creating (we'll need them after)
            const expensesWithFiles = state.unforeseenExpenses.filter((exp: any) => exp.amount > 0)
            const incomesWithFiles = state.unforeseenIncomes.filter((inc: any) => (parseFloat(String(inc.amount)) || 0) > 0)

            const expenseData = expensesWithFiles.map((exp: any) => ({
                amount: roundTo2(parseFloat(String(exp.amount)) || 0),
                description: exp.description || undefined
            }))
            const incomeData = incomesWithFiles.map((inc: any) => ({
                amount: roundTo2(parseFloat(String(inc.amount)) || 0),
                description: inc.description || undefined
            }))

            const totalIncome = state.unforeseenIncomes.reduce((sum: number, inc: any) => sum + (parseFloat(String(inc.amount)) || 0), 0)
            const data = {
                project_id: parseInt(id),
                contract_period_id: viewingPeriodId || undefined,
                income_amount: roundTo2(totalIncome),
                description: state.unforeseenDescription || undefined,
                notes: state.unforeseenNotes || undefined,
                transaction_date: state.unforeseenTransactionDate,
                expenses: expenseData,
                incomes: incomeData
            }

            const createdTx = await UnforeseenTransactionAPI.createUnforeseenTransaction(data)
            const createdExpenses = createdTx?.expenses ?? []
            const createdIncomes = createdTx?.incomes ?? []

            // Update status if not draft
            if (status !== 'draft') {
                if (status === 'waiting_for_approval') {
                    await UnforeseenTransactionAPI.updateUnforeseenTransaction(createdTx.id, {status: 'waiting_for_approval'})
                }
            }

            // Upload documents for expenses - match by order
            for (let i = 0; i < expensesWithFiles.length; i++) {
                const exp = expensesWithFiles[i]
                if (exp.documentFiles && exp.documentFiles.length > 0 && i < createdExpenses.length) {
                    const createdExpense = createdExpenses[i]
                    for (const file of exp.documentFiles) {
                        try {
                            state.setUploadingDocumentForExpense(createdExpense.id)
                            await UnforeseenTransactionAPI.uploadExpenseDocument(createdTx.id, createdExpense.id, file)
                        } catch (err: any) {
                            console.error(`Failed to upload document ${file.name} for expense:`, err)
                            alert(`שגיאה בהעלאת מסמך ${file.name} להוצאה ${i + 1}: ${err.response?.data?.detail || 'שגיאה לא ידועה'}`)
                        } finally {
                            state.setUploadingDocumentForExpense(null)
                        }
                    }
                }
            }

            // Upload documents for incomes - match by order
            for (let i = 0; i < incomesWithFiles.length; i++) {
                const inc = incomesWithFiles[i]
                if (inc.documentFiles && inc.documentFiles.length > 0 && i < createdIncomes.length) {
                    const createdIncome = createdIncomes[i]
                    for (const file of inc.documentFiles) {
                        try {
                            state.setUploadingDocumentForIncome(createdIncome.id)
                            await UnforeseenTransactionAPI.uploadIncomeDocument(createdTx.id, createdIncome.id, file)
                        } catch (err: any) {
                            console.error(`Failed to upload document ${file.name} for income:`, err)
                            alert(`שגיאה בהעלאת מסמך ${file.name} להכנסה ${i + 1}: ${err.response?.data?.detail || 'שגיאה לא ידועה'}`)
                        } finally {
                            state.setUploadingDocumentForIncome(null)
                        }
                    }
                }
            }

            state.setShowCreateUnforeseenTransactionModal(false)
            resetUnforeseenForm()
            // קודם רענון רשימת העסקאות הלא צפויות כדי שהרשימה תופיע מיד
            await dataLoaders.loadUnforeseenTransactions()
            await dataLoaders.loadAllProjectData(viewingPeriodId)
        } catch (err: any) {
            alert(err.response?.data?.detail || 'שגיאה ביצירת העסקה')
        } finally {
            state.setUnforeseenSubmitting(false)
        }
    }

    const handleCreateAndExecuteUnforeseenTransaction = async () => {
        if (!id) return
        state.setUnforeseenSubmitting(true)
        try {
            const expensesWithFiles = state.unforeseenExpenses.filter((exp: any) => exp.amount > 0)
            const incomesWithFiles = state.unforeseenIncomes.filter((inc: any) => (parseFloat(String(inc.amount)) || 0) > 0)

            const expenseData = expensesWithFiles.map((exp: any) => ({
                amount: roundTo2(parseFloat(String(exp.amount)) || 0),
                description: exp.description || undefined
            }))
            const incomeData = incomesWithFiles.map((inc: any) => ({
                amount: roundTo2(parseFloat(String(inc.amount)) || 0),
                description: inc.description || undefined
            }))

            const totalIncome = state.unforeseenIncomes.reduce((sum: number, inc: any) => sum + (parseFloat(String(inc.amount)) || 0), 0)
            const data = {
                project_id: parseInt(id),
                contract_period_id: viewingPeriodId || undefined,
                income_amount: roundTo2(totalIncome),
                description: state.unforeseenDescription || undefined,
                notes: state.unforeseenNotes || undefined,
                transaction_date: state.unforeseenTransactionDate,
                expenses: expenseData,
                incomes: incomeData
            }

            const createdTx = await UnforeseenTransactionAPI.createUnforeseenTransaction(data)
            const createdExpenses = createdTx?.expenses ?? []
            const createdIncomes = createdTx?.incomes ?? []

            // Upload documents for expenses
            for (let i = 0; i < expensesWithFiles.length; i++) {
                const exp = expensesWithFiles[i]
                if (exp.documentFiles && exp.documentFiles.length > 0 && i < createdExpenses.length) {
                    const createdExpense = createdExpenses[i]
                    for (const file of exp.documentFiles) {
                        try {
                            state.setUploadingDocumentForExpense(createdExpense.id)
                            await UnforeseenTransactionAPI.uploadExpenseDocument(createdTx.id, createdExpense.id, file)
                        } catch (err: any) {
                            console.error(`Failed to upload document ${file.name} for expense:`, err)
                            alert(`שגיאה בהעלאת מסמך ${file.name} להוצאה ${i + 1}: ${err.response?.data?.detail || 'שגיאה לא ידועה'}`)
                        } finally {
                            state.setUploadingDocumentForExpense(null)
                        }
                    }
                }
            }

            // Upload documents for incomes
            for (let i = 0; i < incomesWithFiles.length; i++) {
                const inc = incomesWithFiles[i]
                if (inc.documentFiles && inc.documentFiles.length > 0 && i < createdIncomes.length) {
                    const createdIncome = createdIncomes[i]
                    for (const file of inc.documentFiles) {
                        try {
                            state.setUploadingDocumentForIncome(createdIncome.id)
                            await UnforeseenTransactionAPI.uploadIncomeDocument(createdTx.id, createdIncome.id, file)
                        } catch (err: any) {
                            console.error(`Failed to upload document ${file.name} for income:`, err)
                            alert(`שגיאה בהעלאת מסמך ${file.name} להכנסה ${i + 1}: ${err.response?.data?.detail || 'שגיאה לא ידועה'}`)
                        } finally {
                            state.setUploadingDocumentForIncome(null)
                        }
                    }
                }
            }

            await UnforeseenTransactionAPI.executeUnforeseenTransaction(createdTx.id)

            state.setShowCreateUnforeseenTransactionModal(false)
            resetUnforeseenForm()
            await dataLoaders.loadUnforeseenTransactions()
            await dataLoaders.loadAllProjectData(viewingPeriodId)
        } catch (err: any) {
            alert(err.response?.data?.detail || 'שגיאה ביצירת וביצוע העסקה')
        } finally {
            state.setUnforeseenSubmitting(false)
        }
    }

    const handleUpdateUnforeseenTransaction = async (status?: 'draft' | 'waiting_for_approval') => {
        if (!state.editingUnforeseenTransaction) return
        state.setUnforeseenSubmitting(true)
        try {
            const expensesWithFiles = state.unforeseenExpenses.filter((exp: any) => exp.amount > 0)
            const incomesWithFiles = state.unforeseenIncomes.filter((inc: any) => (parseFloat(String(inc.amount)) || 0) > 0)

            const expenseData = expensesWithFiles.map((exp: any) => ({
                amount: roundTo2(parseFloat(String(exp.amount)) || 0),
                description: exp.description || undefined
            }))
            const incomeData = incomesWithFiles.map((inc: any) => ({
                amount: roundTo2(parseFloat(String(inc.amount)) || 0),
                description: inc.description || undefined
            }))

            const totalIncome = state.unforeseenIncomes.reduce((sum: number, inc: any) => sum + (parseFloat(String(inc.amount)) || 0), 0)
            const updateData: any = {
                income_amount: roundTo2(totalIncome),
                description: state.unforeseenDescription || undefined,
                notes: state.unforeseenNotes || undefined,
                transaction_date: state.unforeseenTransactionDate,
                expenses: expenseData,
                incomes: incomeData
            }

            if (status) {
                updateData.status = status
            }

            await UnforeseenTransactionAPI.updateUnforeseenTransaction(state.editingUnforeseenTransaction?.id || 0, updateData)

            const updatedTx = await UnforeseenTransactionAPI.getUnforeseenTransaction(state.editingUnforeseenTransaction?.id || 0)
            const txId = state.editingUnforeseenTransaction?.id || 0
            const updatedExpenses = updatedTx?.expenses ?? []
            const updatedIncomes = updatedTx?.incomes ?? []

            // רענון מלא של העמוד (F5) אחרי עדכון מוצלח
            state.setShowCreateUnforeseenTransactionModal(false)
            state.setEditingUnforeseenTransaction(null)
            resetUnforeseenForm()

            // העלאת מסמכים לפני הרענון – כישלון בהעלאה לא מונע רענון
            for (let i = 0; i < expensesWithFiles.length; i++) {
                const exp = expensesWithFiles[i]
                if (exp.documentFiles && exp.documentFiles.length > 0) {
                    let expenseIdToUse: number | null = null
                    if (exp.expenseId) {
                        const matchingExpense = updatedExpenses.find((e: any) => e.id === exp.expenseId)
                        if (matchingExpense) expenseIdToUse = matchingExpense.id
                    } else if (i < updatedExpenses.length) {
                        expenseIdToUse = updatedExpenses[i].id
                    }
                    if (expenseIdToUse) {
                        for (const file of exp.documentFiles) {
                            try {
                                state.setUploadingDocumentForExpense(expenseIdToUse)
                                await UnforeseenTransactionAPI.uploadExpenseDocument(txId, expenseIdToUse, file)
                            } catch (err: any) {
                                console.error(`Failed to upload document ${file.name} for expense:`, err)
                                alert(`שגיאה בהעלאת מסמך ${file.name} להוצאה ${i + 1}: ${err.response?.data?.detail || 'שגיאה לא ידועה'}`)
                            } finally {
                                state.setUploadingDocumentForExpense(null)
                            }
                        }
                    }
                }
            }

            for (let i = 0; i < incomesWithFiles.length; i++) {
                const inc = incomesWithFiles[i]
                if (inc.documentFiles && inc.documentFiles.length > 0 && i < updatedIncomes.length) {
                    const incomeIdToUse = updatedIncomes[i].id
                    for (const file of inc.documentFiles) {
                            try {
                                state.setUploadingDocumentForIncome(incomeIdToUse)
                                await UnforeseenTransactionAPI.uploadIncomeDocument(txId, incomeIdToUse, file)
                            } catch (err: any) {
                                console.error(`Failed to upload document ${file.name} for income:`, err)
                                alert(`שגיאה בהעלאת מסמך ${file.name} להכנסה ${i + 1}: ${err.response?.data?.detail || 'שגיאה לא ידועה'}`)
                            } finally {
                                state.setUploadingDocumentForIncome(null)
                            }
                        }
                }
            }

            await dataLoaders.loadUnforeseenTransactions()
            await dataLoaders.loadAllProjectData(viewingPeriodId)
        } catch (err: any) {
            alert(err.response?.data?.detail || 'שגיאה בעדכון העסקה')
        } finally {
            state.setUnforeseenSubmitting(false)
        }
    }

    const handleDeleteBudget = async (budgetId: number) => {
        if (!confirm('האם אתה בטוח שברצונך למחוק את התקציב?')) {
            return
        }
        try {
            state.setBudgetDeleteLoading(budgetId)
            await BudgetAPI.deleteBudget(budgetId)
            await dataLoaders.reloadChartsDataOnly() // Only reload budgets and categories, not transactions
        } catch (err: any) {
            alert(err?.response?.data?.detail || 'שגיאה במחיקת התקציב')
        } finally {
            state.setBudgetDeleteLoading(null)
        }
    }

    const handleAddBudget = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!id) return
        if (!state.newBudgetForm.amount || Number(state.newBudgetForm.amount) <= 0) {
            state.setBudgetFormError('יש להזין סכום חיובי')
            return
        }
        if (!state.newBudgetForm.start_date) {
            state.setBudgetFormError('יש לבחור תאריך התחלה')
            return
        }

        // Check if budget already exists for this category
        const existingBudget = state.projectBudgets.find(
            budget => budget.category === state.newBudgetForm.category
        )
        if (existingBudget) {
            state.setBudgetFormError(`כבר קיים תקציב לקטגוריה "${state.newBudgetForm.category}". ניתן לערוך את התקציב הקיים או למחוק אותו לפני יצירת תקציב חדש.`)
            return
        }

        try {
            state.setBudgetSaving(true)
            state.setBudgetFormError(null)
            await BudgetAPI.createBudget({
                project_id: parseInt(id),
                category: state.newBudgetForm.category,
                amount: Number(state.newBudgetForm.amount),
                period_type: state.newBudgetForm.period_type,
                start_date: state.newBudgetForm.start_date,
                end_date: state.newBudgetForm.period_type === 'Annual' ? (state.newBudgetForm.end_date || null) : null,
                contract_period_id: effectiveBudgetPeriodId
            })
            await dataLoaders.reloadChartsDataOnly() // Only reload budgets and categories, not transactions
            state.setShowAddBudgetForm(false)
            state.setBudgetDateMode('today')
            state.setNewBudgetForm({
                category: '',
                amount: '',
                period_type: 'Annual',
                start_date: new Date().toISOString().split('T')[0],
                end_date: ''
            })
        } catch (err: any) {
            state.setBudgetFormError(err?.response?.data?.detail || 'שגיאה ביצירת התקציב')
        } finally {
            state.setBudgetSaving(false)
        }
    }

    const handleStartEditBudget = (budget: any) => {
        const normalizedStart = budget.start_date ? budget.start_date.slice(0, 10) : ''
        const normalizedEnd = budget.end_date ? budget.end_date.slice(0, 10) : ''
        state.setBudgetToEdit(budget)
        state.setEditBudgetError(null)
        state.setEditBudgetForm({
            category: budget.category,
            amount: Number(budget.base_amount ?? budget.amount).toString(),
            period_type: budget.period_type,
            start_date: normalizedStart,
            end_date: normalizedEnd,
            is_active: budget.is_active
        })
        state.setShowEditBudgetForm(true)
    }

    const handleUpdateBudget = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (!state.budgetToEdit) return
        if (!state.editBudgetForm.category) {
            state.setEditBudgetError('יש לבחור קטגוריה')
            return
        }
        const parsedAmount = Number(state.editBudgetForm.amount)
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            state.setEditBudgetError('יש להזין סכום חיובי')
            return
        }
        if (!state.editBudgetForm.start_date) {
            state.setEditBudgetError('יש לבחור תאריך התחלה')
            return
        }
        try {
            state.setEditBudgetSaving(true)
            state.setEditBudgetError(null)
            await BudgetAPI.updateBudget(state.budgetToEdit.id, {
                category: state.editBudgetForm.category,
                amount: parsedAmount,
                period_type: state.editBudgetForm.period_type,
                start_date: state.editBudgetForm.start_date,
                end_date: state.editBudgetForm.period_type === 'Annual' ? (state.editBudgetForm.end_date || null) : null,
                is_active: state.editBudgetForm.is_active
            })
            await dataLoaders.reloadChartsDataOnly() // Only reload budgets and categories, not transactions
            state.setShowEditBudgetForm(false)
            state.setBudgetToEdit(null)
        } catch (err: any) {
            state.setEditBudgetError(err?.response?.data?.detail || 'שגיאה בעדכון התקציב')
        } finally {
            state.setEditBudgetSaving(false)
        }
    }


    const handleEditAnyTransaction = async (transaction: Transaction) => {
        // If it's a recurring transaction (has recurring_template_id), always ask the user whether to edit the instance or the template
        // Check both is_generated and recurring_template_id to catch all recurring transactions
        if (transaction.recurring_template_id || transaction.is_generated) {
            state.setSelectedTransactionForEdit(transaction)
            state.setShowRecurringSelectionModal(true)
            return
        }

        state.setSelectedTransactionForEdit(transaction)
        state.setEditTransactionModalOpen(true)
    }

    // Selection Modal Handler
    const handleEditRecurringSelection = async (mode: 'instance' | 'series') => {
        if (!state.selectedTransactionForEdit) {
            state.setShowRecurringSelectionModal(false)
            return
        }

        if (mode === 'instance') {
            // Close selection modal and open edit transaction modal
            state.setShowRecurringSelectionModal(false)
            state.setEditTransactionModalOpen(true)
        } else {
            // Series mode - edit the entire template
            try {
                let templateId = state.selectedTransactionForEdit.recurring_template_id

                // If templateId is not found, try to find it by matching transaction details
                if (!templateId) {
                    try {
                        // Load all templates for the project
                        const templates = await RecurringTransactionAPI.getProjectRecurringTemplates(parseInt(id || '0'))
                        // Find matching template by description, amount, supplier, and type
                        const matchingTemplate = templates.find((t: any) =>
                            t.description === state.selectedTransactionForEdit.description &&
                            t.amount === state.selectedTransactionForEdit.amount &&
                            t.type === state.selectedTransactionForEdit.type &&
                            (t.supplier_id === state.selectedTransactionForEdit.supplier_id ||
                                (!t.supplier_id && !state.selectedTransactionForEdit.supplier_id))
                        )

                        if (matchingTemplate) {
                            templateId = matchingTemplate.id
                        }
                    } catch (searchErr) {
                        console.error('Failed to search for template', searchErr)
                    }
                }

                if (!templateId) {
                    alert('לא נמצא מזהה תבנית. לא ניתן לערוך את כל הסדרה.')
                    state.setShowRecurringSelectionModal(false)
                    return
                }

                // Close selection modal first
                state.setShowRecurringSelectionModal(false)

                // Set pending flag and open modal (will show loading state)
                state.setPendingTemplateLoad(true)
                state.setEditTemplateModalOpen(true)

                // Then load the template
                const templateResponse = await RecurringTransactionAPI.getTemplate(templateId)
                // The API returns template with generated_transactions, but we only need the template part
                // Extract just the template properties (exclude generated_transactions if it exists)
                const {generated_transactions, ...templateData} = templateResponse as any
                // Set the template - this will trigger the form to load
                state.setSelectedTemplateForEdit(templateData as any)
                state.setPendingTemplateLoad(false)
            } catch (err: any) {
                console.error('Failed to fetch template', err)
                state.setPendingTemplateLoad(false)
                state.setEditTemplateModalOpen(false)
                state.setShowRecurringSelectionModal(false)
                alert('שגיאה בטעינת פרטי המחזוריות: ' + (err.response?.data?.detail || err.message))
            }
        }
    }



    const handleDeleteTransaction = async (transactionId: number, transaction?: Transaction) => {
        // Find the full transaction object if not provided
        const fullTransaction = transaction || state.txs.find((t: Transaction) => t.id === transactionId)
        if (!fullTransaction) {
            alert('עסקה לא נמצאה')
            return
        }

        // Set the transaction to delete and open the modal
        state.setTransactionToDelete(fullTransaction)
        state.setShowDeleteTransactionModal(true)
    }

    const confirmDeleteTransaction = async (deleteAll: boolean) => {
        if (!state.transactionToDelete) return

        state.setIsDeletingTransaction(true)
        try {
            const isRecurring = state.transactionToDelete.recurring_template_id || state.transactionToDelete.is_generated
            const isPeriod = !!(state.transactionToDelete.period_start_date && state.transactionToDelete.period_end_date)

            if (isRecurring) {
                // For recurring transactions
                if (deleteAll) {
                    // Delete the entire template (which will delete all instances)
                    const templateId = state.transactionToDelete.recurring_template_id
                    if (!templateId) {
                        throw new Error('לא נמצא מזהה תבנית מחזורית')
                    }
                    await RecurringTransactionAPI.deleteTemplate(templateId)
                } else {
                    // Delete only this instance
                    await RecurringTransactionAPI.deleteTransactionInstance(state.transactionToDelete.id)
                }
                // For recurring transactions, only reload transactions without regenerating
                // to prevent recreating the deleted instance
                await dataLoaders.loadTransactionsOnly()
            } else if (isPeriod && deleteAll) {
                // For period transactions, delete all transactions with the same period dates
                const periodStart = state.transactionToDelete.period_start_date
                const periodEnd = state.transactionToDelete.period_end_date

                if (!periodStart || !periodEnd) {
                    // Fallback to single deletion if dates are missing
                    await api.delete(`/transactions/${state.transactionToDelete.id}`)
                } else {
                    // Find all transactions with the same period dates
                    const matchingTransactions = state.txs.filter((t: Transaction) =>
                        t.period_start_date === periodStart &&
                        t.period_end_date === periodEnd &&
                        t.id !== (state.transactionToDelete?.id || 0) // Don't delete the same transaction twice
                    )

                    // Delete all matching transactions
                    const deletePromises = [
                        api.delete(`/transactions/${state.transactionToDelete.id}`),
                        ...matchingTransactions.map((t: Transaction) => api.delete(`/transactions/${t.id}`))
                    ]

                    await Promise.all(deletePromises)
                }
                // Use loadAllProjectData with viewingPeriodId to maintain historical period filtering
                await dataLoaders.loadAllProjectData(viewingPeriodId)
                await dataLoaders.loadUnforeseenTransactions()
            } else {
                // Regular transaction or single period transaction deletion
                await api.delete(`/transactions/${state.transactionToDelete.id}`)
                // Use loadAllProjectData with viewingPeriodId to maintain historical period filtering
                await dataLoaders.loadAllProjectData(viewingPeriodId)
                await dataLoaders.loadUnforeseenTransactions()
            }

            // If period summary modal is open, refresh the summary to reflect deleted transaction
            if (state.selectedPeriodSummary) {
                try {
                    const summary = await ProjectAPI.getContractPeriodSummary(
                        parseInt(id!),
                        state.selectedPeriodSummary.period_id,
                        state.selectedPeriodSummary.start_date,
                        state.selectedPeriodSummary.end_date
                    )
                    state.setSelectedPeriodSummary(summary)
                } catch (err: any) {
                    // Silently fail - summary will be refreshed when user reopens modal
                    console.error('Failed to refresh period summary:', err)
                }
            }

            // Close modal and reset state
            state.setShowDeleteTransactionModal(false)
            state.setTransactionToDelete(null)
        } catch (err: any) {
            alert(err.response?.data?.detail ?? 'שגיאה במחיקת העסקה')
        } finally {
            state.setIsDeletingTransaction(false)
        }
    }

    // Calculate income and expense based on the global date filter
    // Only actual transactions are counted - budget is NOT included in income
    // This uses the same global filter as transactions list for consistency

    if (!id) {
        return (
            <div className="space-y-4">
                <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded">
                    מזהה פרויקט לא תקין
                </div>
                <button
                    onClick={() => navigate('/dashboard')}
                    className="bg-gray-900 text-white px-4 py-2 rounded"
                >
                    חזור לדשבורד
                </button>
            </div>
        )
    }

    // Don't render main content if redirecting to parent project route
    if (state.isParentProject && id && !isNaN(Number(id)) && !state.loading) {
        return (
            <div className="space-y-4">
                <div className="flex items-center justify-center min-h-[400px]">
                    <div className="text-center">
                        <div
                            className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                        <p className="text-lg font-semibold text-gray-900 dark:text-white">
                            מעביר לדף פרויקט אב...
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    // Show error message if there was an error loading data
    if (state.error && !state.loading) {
        return (
            <div className="space-y-4">
                <div
                    className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 p-6 rounded-lg">
                    <h2 className="text-xl font-bold mb-2">שגיאה בטעינת הפרויקט</h2>
                    <p className="mb-4">{state.error}</p>
                    <div className="flex gap-3">
                        <button
                            onClick={() => {
                                state.setError(null)
                                if (id && !isNaN(Number(id))) {
                                    dataLoaders.loadAllProjectData(viewingPeriodId)
                                }
                            }}
                            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors"
                        >
                            נסה שוב
                        </button>
                        <button
                            onClick={() => navigate('/dashboard')}
                            className="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 rounded-lg transition-colors"
                        >
                            חזור לדשבורד
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="project-detail-page space-y-8 relative px-4 md:px-6">
            {/* Loading Overlay */}
            <LoadingOverlay loading={state.loading} updatingProject={state.updatingProject} />

            {/* Historical Period Banner */}
            {isViewingHistoricalPeriod && state.selectedPeriod && (
                <HistoricalPeriodBanner
                    selectedPeriod={state.selectedPeriod}
                    prevPeriod={prevPeriod}
                    nextPeriod={nextPeriod}
                    onNavigateToPeriod={(periodId) => setSearchParams({period: periodId.toString()})}
                    onReturnToCurrent={() => setSearchParams({})}
                />
            )}

            {/* Header */}
            <ProjectHeader
                id={id}
                projectName={state.projectName}
                projectImageUrl={state.projectImageUrl}
                projectStartDate={state.projectStartDate}
                projectEndDate={state.projectEndDate}
                contractFileUrl={state.contractFileUrl}
                isParentProject={state.isParentProject}
                isAdmin={isAdmin}
                totalPeriods={totalPeriods}
                hasFund={state.hasFund}
                fundData={state.fundData}
                isViewingHistoricalPeriod={isViewingHistoricalPeriod}
                onShowContractModal={() => state.setShowContractModal(true)}
                onShowPreviousYearsModal={() => state.setShowPreviousYearsModal(true)}
                onShowCreateTransactionModal={() => state.setShowCreateTransactionModal(true)}
                onShowAddBudgetForm={() => {
                    state.setShowAddBudgetForm(true)
                    state.setBudgetFormError(null)
                    state.setBudgetDateMode(isViewingHistoricalPeriod ? 'project_start' : 'today')
                }}
                onShowCreateFundModal={() => {
                    state.setFundScopePreviousYear(null)
                    state.setShowCreateFundModal(true)
                }}
                onEditProject={handleEditProject}
                onArchiveDeleteClick={handleArchiveDeleteClick}
                onNavigate={navigate}
            />

            {/* Accepted price quote - הצעת מחיר שאושרה (when project was created from a quote) */}
            {state.acceptedQuote && (
                <div className="w-full max-w-7xl mx-auto">
                    <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
                        <span className="text-emerald-800 dark:text-emerald-200 text-sm font-medium">
                            הצעת מחיר שאושרה:
                        </span>
                        <Link
                            to={`/price-quotes/${state.acceptedQuote.id}`}
                            className="text-emerald-700 dark:text-emerald-300 font-semibold hover:underline"
                        >
                            {state.acceptedQuote.name}
                        </Link>
                    </div>
                </div>
            )}

            {/* Global Date Filter - Affects all sections */}
            <GlobalDateFilter
                isViewingHistoricalPeriod={isViewingHistoricalPeriod}
                selectedPeriod={state.selectedPeriod}
                globalDateFilterMode={state.globalDateFilterMode}
                globalSelectedMonth={state.globalSelectedMonth}
                globalStartDate={state.globalStartDate}
                globalEndDate={state.globalEndDate}
                projectStartDate={state.projectStartDate}
                onDateFilterModeChange={state.setGlobalDateFilterMode}
                onSelectedMonthChange={state.setGlobalSelectedMonth}
                onStartDateChange={state.setGlobalStartDate}
                onEndDateChange={state.setGlobalEndDate}
            />

            {/* Subprojects List */}
            <SubprojectsList
                isParentProject={state.isParentProject}
                subprojects={state.subprojects}
                subprojectsLoading={state.subprojectsLoading}
                onNavigate={navigate}
            />


            {/* Main content - consistent width; grid/flex children wrap as whole blocks */}
            <div className="project-detail-main-content w-full max-w-7xl mx-auto space-y-6">
            {/* KPIs - Compact row */}
            <FinancialSummary
                income={income}
                expense={expense}
                fundBalance={state.fundData?.current_balance}
            />

            {/* Main dashboard: Chart + Fund & Unforeseen side by side; wrap as whole blocks */}
            <div className="project-detail-grid-dashboard grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-6">
                {/* Project documentation above the trends chart. The board always shows in full (compact
                    when empty, up to 32rem with notes); the chart stretches to fill the rest, so this column
                    ends level with the fund column (the grid stretches both cells to the row height). */}
                <div className="lg:col-span-3 min-w-0 flex flex-col gap-6">
                {id && !state.isParentProject && (
                    <div id="project-notes" className="project-detail-section min-w-0 flex-shrink-0">
                        <ProjectNotesBoard projectId={Number(id)} board="general" />
                    </div>
                )}
                {/* Trends chart (wider) */}
                <div className="project-detail-section project-detail-card flex-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4 sm:p-5 overflow-hidden min-h-[260px] min-w-0">
                    <ProjectTrendsChart
                        projectId={parseInt(id || '0')}
                        projectName={state.projectName}
                        transactions={state.txs}
                        expenseCategories={state.expenseCategories}
                        compact={true}
                        projectIncome={state.projectBudget?.budget_monthly || 0}
                        globalFilterType={state.globalDateFilterMode}
                        globalSelectedMonth={state.globalSelectedMonth}
                        globalStartDate={state.globalStartDate}
                        globalEndDate={state.globalEndDate}
                        hideFilterControls={true}
                    />
                </div>
                </div>
                {/* Right: Fund + Unforeseen */}
                <div id="project-fund" className="project-detail-section project-detail-card lg:col-span-2 flex flex-col min-h-[260px] min-w-0">
                    <FundAndUnforeseenPanel
                        fundData={state.fundData}
                        fundLoading={state.fundLoading}
                        unforeseenTransactions={state.unforeseenTransactions}
                        unforeseenTransactionsLoading={state.unforeseenTransactionsLoading}
                        onShowFundTransactionsModal={() => state.setShowFundTransactionsModal(true)}
                        onShowEditFundModal={() => {
                            if (state.fundData) {
                                state.setMonthlyFundAmount(state.fundData.monthly_amount)
                                state.setCurrentBalance(state.fundData.current_balance)
                                state.setShowEditFundModal(true)
                            }
                        }}
                        onShowUnforeseenTransactionsModal={() => state.setShowUnforeseenTransactionsModal(true)}
                        onShowCreateUnforeseenTransactionModal={() => state.setShowCreateUnforeseenTransactionModal(true)}
                        onResetUnforeseenForm={resetUnforeseenForm}
                        onShowDeleteFundModal={() => state.setShowDeleteFundModal(true)}
                        fundNotes={id && !state.isParentProject && state.fundData
                            ? <ProjectNotesBoard projectId={Number(id)} board="fund" />
                            : undefined}
                        onViewUnforeseenTransaction={async (tx) => {
                            state.setUnforeseenDetailsReadOnly(false)
                            try {
                                const fresh = await UnforeseenTransactionAPI.getUnforeseenTransaction(tx.id)
                                state.setSelectedUnforeseenTransactionForDetails(fresh as any)
                            } catch (_) {
                                state.setSelectedUnforeseenTransactionForDetails(tx as any)
                            }
                            state.setShowUnforeseenTransactionDetailsModal(true)
                        }}
                    />
                </div>
            </div>

            {/* Budgets + Transactions - side by side; when no room, blocks wrap to next row */}
            <div className="project-detail-grid-budgets grid grid-cols-1 xl:grid-cols-[1fr_minmax(20rem,28rem)] gap-6 items-start">
                <div className="project-detail-section min-w-0">
                    <BudgetsAndCharts
                        chartsLoading={state.chartsLoading}
                        projectBudgets={state.projectBudgets}
                        budgetDeleteLoading={state.budgetDeleteLoading}
                        onDeleteBudget={handleDeleteBudget}
                        onEditBudget={handleStartEditBudget}
                    />
                </div>
                <div id="project-transactions" className="project-detail-section project-detail-card w-full min-w-0 max-w-[28rem] mx-auto xl:max-w-none xl:mx-0">
                    <TransactionsList
                    txs={state.txs}
                    loading={state.loading}
                    transactionTypeFilter={state.transactionTypeFilter}
                    filterType={state.filterType}
                    filterExceptional={state.filterExceptional}
                    filterDated={state.filterDated}
                    categoryFilter={state.categoryFilter}
                    allCategoryOptions={allCategoryOptions}
                    dateFilterMode={dateFilterMode}
                    selectedMonth={selectedMonth}
                    startDate={startDate}
                    endDate={endDate}
                    viewingPeriodId={viewingPeriodId}
                    suppliers={suppliers}
                    onSetFilterType={state.setFilterType}
                    onSetFilterExceptional={state.setFilterExceptional}
                    onSetFilterDated={state.setFilterDated}
                    onSetCategoryFilter={state.setCategoryFilter}
                    onSetDateFilterMode={setDateFilterMode}
                    onShowTransactionDetails={async (tx: Transaction) => {
                        if ((tx as any).is_unforeseen) {
                            try {
                                const fresh = await UnforeseenTransactionAPI.getUnforeseenTransactionByResultingTransactionId(tx.id)
                                state.setSelectedUnforeseenTransactionForDetails(fresh as any)
                                state.setUnforeseenDetailsReadOnly(true)
                                state.setShowUnforeseenTransactionDetailsModal(true)
                            } catch (_) {
                                alert('לא נמצאה עסקה לא צפויה מקושרת')
                            }
                        } else {
                            state.setSelectedTransactionForDetails(tx)
                            state.setShowTransactionDetailsModal(true)
                        }
                    }}
                    onShowDocumentsModal={async (tx: Transaction) => {
                        state.setSelectedTransactionForDocuments(tx)
                        state.setShowDocumentsModal(true)
                        state.setDocumentsLoading(true)
                        try {
                            const {data} = await api.get(`/transactions/${tx.id}/documents`)
                            state.setTransactionDocuments(data || [])
                        } catch (err) {
                            state.setTransactionDocuments([])
                        } finally {
                            state.setDocumentsLoading(false)
                        }
                    }}
                    onEditTransaction={handleEditAnyTransaction}
                    onDeleteTransaction={handleDeleteTransaction}
                />
                </div>
            </div>

                {/* Transaction Details Modal */}
                <TransactionDetailsModal
                    isOpen={state.showTransactionDetailsModal}
                    transaction={state.selectedTransactionForDetails}
                    suppliers={suppliers}
                    onClose={() => {
                        state.setShowTransactionDetailsModal(false)
                        state.setSelectedTransactionForDetails(null)
                    }}
                    onShowDocumentsModal={async (tx: Transaction) => {
                        state.setShowTransactionDetailsModal(false)
                        state.setSelectedTransactionForDocuments(tx)
                        state.setShowDocumentsModal(true)
                        state.setDocumentsLoading(true)
                        try {
                            const {data} = await api.get(`/transactions/${tx.id}/documents`)
                            state.setTransactionDocuments(data || [])
                        } catch (err) {
                            state.setTransactionDocuments([])
                        } finally {
                            state.setDocumentsLoading(false)
                        }
                    }}
                    onEditTransaction={(tx: Transaction) => {
                        state.setShowTransactionDetailsModal(false)
                        handleEditAnyTransaction(tx)
                    }}
                    onDeleteTransaction={(id: number, tx: Transaction) => {
                        state.setShowTransactionDetailsModal(false)
                        handleDeleteTransaction(id, tx)
                    }}
                />

                {/* Fund Modals */}
                <FundModals
                    showEditFundModal={state.showEditFundModal}
                    showCreateFundModal={state.showCreateFundModal}
                    showFundTransactionsModal={state.showFundTransactionsModal}
                    fundData={state.fundData}
                    monthlyFundAmount={state.monthlyFundAmount}
                    currentBalance={state.currentBalance}
                    fundUpdateScope={state.fundUpdateScope}
                    updatingFund={state.updatingFund}
                    fundCategoryFilter={state.fundCategoryFilter}
                    id={id}
                    projectStartDate={state.projectStartDate}
                    onCloseEditFund={() => {
                        state.setShowEditFundModal(false)
                        state.setMonthlyFundAmount(0)
                        state.setCurrentBalance(0)
                    }}
                    onCloseCreateFund={() => {
                        state.setShowCreateFundModal(false)
                        state.setMonthlyFundAmount(0)
                    }}
                    onCloseFundTransactions={() => state.setShowFundTransactionsModal(false)}
                    onSetMonthlyFundAmount={state.setMonthlyFundAmount}
                    onSetCurrentBalance={state.setCurrentBalance}
                    onSetFundUpdateScope={state.setFundUpdateScope}
                    onLoadFundData={dataLoaders.loadFundData}
                    onLoadProjectInfo={dataLoaders.loadProjectInfo}
                    onShowDocumentsModal={async (tx: Transaction) => {
                        state.setSelectedTransactionForDocuments(tx)
                        state.setShowDocumentsModal(true)
                        state.setDocumentsLoading(true)
                        try {
                            const {data} = await api.get(`/transactions/${tx.id}/documents`)
                            state.setTransactionDocuments(data || [])
                        } catch (err) {
                            state.setTransactionDocuments([])
                        } finally {
                            state.setDocumentsLoading(false)
                        }
                    }}
                    onEditTransaction={handleEditAnyTransaction}
                    onDeleteTransaction={handleDeleteTransaction}
                    showDeleteFundModal={state.showDeleteFundModal}
                    deleteFundPassword={state.deleteFundPassword}
                    deleteFundPasswordError={state.deleteFundPasswordError}
                    isDeletingFund={state.isDeletingFund}
                    onCloseDeleteFundModal={() => {
                        state.setShowDeleteFundModal(false)
                        state.setDeleteFundPassword('')
                        state.setDeleteFundPasswordError('')
                    }}
                    onSetDeleteFundPassword={state.setDeleteFundPassword}
                    onDeleteFund={handleDeleteFund}
                />
            </div>
            {/* End main content wrapper */}

            {/* Legacy Transactions Block (disabled) */}
            {false && (
                <motion.div
                    initial={{opacity: 0, y: 20}}
                    animate={{opacity: 1, y: 0}}
                    transition={{delay: 0.3}}
                    className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6"
                >
                    <div className="mb-6">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-xl font-semibold text-gray-900 dark:text-white">
                                רשימת עסקאות
                            </h3>
                            <div className="flex items-center gap-4">
                                <div className="flex items-center gap-3">
                                    <select
                                        className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        value={state.filterType}
                                        onChange={e => state.setFilterType(e.target.value as 'all' | 'Income' | 'Expense' | 'unforeseen')}
                                    >
                                        <option value="all">הכל</option>
                                        <option value="Income">הכנסות</option>
                                        <option value="Expense">הוצאות</option>
                                        <option value="unforeseen">עסקאות לא צפויות</option>
                                    </select>
                                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                        <input
                                            type="checkbox"
                                            checked={state.filterExceptional === 'only'}
                                            onChange={e => state.setFilterExceptional(e.target.checked ? 'only' : 'all')}
                                            className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                                        />
                                        רק חריגות
                                    </label>
                                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                        <input
                                            type="checkbox"
                                            checked={state.filterDated === 'only'}
                                            onChange={e => state.setFilterDated(e.target.checked ? 'only' : 'all')}
                                            className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
                                        />
                                        רק תאריכיות
                                    </label>
                                </div>
                                <div>
                                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                                        <span>קטגוריה:</span>
                                        <select
                                            className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            value={state.categoryFilter}
                                            onChange={(e) => state.setCategoryFilter(e.target.value)}
                                        >
                                            <option value="all">כל הקטגוריות</option>
                                            {allCategoryOptions.map(option => (
                                                <option key={option} value={option}>{option}</option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {/* Date Filter Options */}
                        <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    סינון לפי תאריך
                                </label>
                                <div className="flex flex-wrap gap-4">
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            value="current_month"
                                            checked={dateFilterMode === 'current_month'}
                                            onChange={() => setDateFilterMode('current_month')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">חודש נוכחי</span>
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            value="selected_month"
                                            checked={dateFilterMode === 'selected_month'}
                                            onChange={() => setDateFilterMode('selected_month')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">חודש מסוים</span>
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="dateFilter"
                                            value="date_range"
                                            checked={dateFilterMode === 'date_range'}
                                            onChange={() => setDateFilterMode('date_range')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">טווח תאריכים</span>
                                    </label>
                                </div>
                            </div>

                            {dateFilterMode === 'selected_month' && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                        בחר חודש
                                    </label>
                                    <input
                                        type="month"
                                        value={selectedMonth}
                                        onChange={(e) => setSelectedMonth(e.target.value)}
                                        className="px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                            )}

                            {dateFilterMode === 'date_range' && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <label
                                            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                            מתאריך
                                        </label>
                                        <input
                                            type="date"
                                            value={startDate}
                                            onChange={(e) => setStartDate(e.target.value)}
                                            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                    <div>
                                        <label
                                            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                            עד תאריך
                                        </label>
                                        <input
                                            type="date"
                                            value={endDate}
                                            onChange={(e) => setEndDate(e.target.value)}
                                            min={startDate}
                                            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Transaction Type Filter */}
                        <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    סוג עסקה
                                </label>
                                <div className="flex flex-wrap gap-4">
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="transactionType"
                                            value="all"
                                            checked={state.transactionTypeFilter === 'all'}
                                            onChange={() => state.setTransactionTypeFilter('all')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">הכל</span>
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="transactionType"
                                            value="regular"
                                            checked={state.transactionTypeFilter === 'regular'}
                                            onChange={() => state.setTransactionTypeFilter('regular')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">רגיל</span>
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="transactionType"
                                            value="recurring"
                                            checked={state.transactionTypeFilter === 'recurring'}
                                            onChange={() => state.setTransactionTypeFilter('recurring')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">מחזורי</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {/* Transaction Type Filter */}
                        <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    סוג עסקה
                                </label>
                                <div className="flex flex-wrap gap-4">
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="transactionType"
                                            value="all"
                                            checked={state.transactionTypeFilter === 'all'}
                                            onChange={() => state.setTransactionTypeFilter('all')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">הכל</span>
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="transactionType"
                                            value="regular"
                                            checked={state.transactionTypeFilter === 'regular'}
                                            onChange={() => state.setTransactionTypeFilter('regular')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">רגיל</span>
                                    </label>
                                    <label className="flex items-center gap-2">
                                        <input
                                            type="radio"
                                            name="transactionType"
                                            value="recurring"
                                            checked={state.transactionTypeFilter === 'recurring'}
                                            onChange={() => state.setTransactionTypeFilter('recurring')}
                                            className="w-4 h-4 text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700 dark:text-gray-300">מחזורי</span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>

                    {state.loading ? (
                        <div className="text-center py-8 text-gray-500 dark:text-gray-400">טוען...</div>
                    ) : (state.transactionTypeFilter === 'recurring' ? state.recurringTemplates.length === 0 : (state.txs || []).length === 0) ? (
                        <div className="text-center py-8 space-y-3">
                            <div className="text-gray-500 dark:text-gray-400 font-medium">אין עסקאות להצגה</div>
                            {state.txs.length > 0 && (
                                <div className="text-sm text-gray-400 dark:text-gray-500 space-y-2">
                                    {state.categoryFilter !== 'all' && (
                                        <>
                                            <div>הסינון לפי קטגוריה "{state.categoryFilter}" לא מצא תוצאות</div>
                                            {0 > 0 && dateFilterMode === 'current_month' && (
                                                <div
                                                    className="mt-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                                                    <div className="font-medium text-blue-800 dark:text-blue-200 mb-1">
                                                        נמצאו 0 עסקאות עם הקטגוריה
                                                        "{state.categoryFilter}"
                                                    </div>
                                                    <div className="text-blue-700 dark:text-blue-300 text-xs mb-2">
                                                        אבל הן לא בחודש הנוכחי. שנה את סינון התאריך לראות אותן.
                                                    </div>
                                                    <button
                                                        onClick={() => setDateFilterMode('date_range')}
                                                        className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                                                    >
                                                        הצג את כל העסקאות עם הקטגוריה הזו
                                                    </button>
                                                </div>
                                            )}
                                            {0 === 0 && (
                                                <div className="text-xs text-gray-500 dark:text-gray-400">
                                                    אין עסקאות עם הקטגוריה "{state.categoryFilter}" במערכת
                                                </div>
                                            )}
                                        </>
                                    )}
                                    {state.categoryFilter === 'all' && dateFilterMode === 'current_month' && (
                                        <div className="mt-1">התצוגה מוגבלת לחודש הנוכחי - נסה לשנות את סינון התאריך
                                            לראות עסקאות מחודשים קודמים</div>
                                    )}
                                    {state.categoryFilter === 'all' && dateFilterMode === 'date_range' && (
                                        <div className="mt-1">לא נמצאו עסקאות בטווח התאריכים שנבחר. נסה להרחיב את הטווח
                                            או לנקות את הסינון.</div>
                                    )}
                                    {state.categoryFilter === 'all' && dateFilterMode === 'all_time' && (
                                        <div className="mt-1">לא נמצאו עסקאות כלל במערכת.</div>
                                    )}
                                    <div className="mt-2 text-xs">
                                        סך הכל {state.txs.filter((t: Transaction) => !t.from_fund).length} עסקאות במערכת
                                        {state.categoryFilter !== 'all' && 0 > 0 && (
                                            <span> • {0} עם הקטגוריה "{state.categoryFilter}"</span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                <tr className="bg-gray-50 dark:bg-gray-700 text-right">
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">סוג</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">
                                        {state.transactionTypeFilter === 'recurring' ? 'תדירות' : 'תאריך'}
                                    </th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">סכום</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">קטגוריה</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">אמצעי תשלום</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">ספק</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">נוצר על ידי</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">תיאור</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">הערות</th>
                                    <th className="p-3 font-medium text-gray-700 dark:text-gray-300">פעולות</th>
                                </tr>
                                </thead>
                                <tbody>
                                {state.transactionTypeFilter === 'recurring' ? (
                                    state.recurringTemplates.map((template: any) => (
                                        <tr key={template.id}
                                            className="border-t border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
                                            <td className="p-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            template.type === 'Income'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300'
                                : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300'
                        }`}>
                          {template.type === 'Income' ? 'הכנסה' : 'הוצאה'}
                        </span>
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                כל {template.day_of_month} בחודש
                                            </td>
                                            <td className={`p-3 font-semibold ${template.type === 'Income' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                {Number(template.amount || 0).toFixed(2)} ₪
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                {template.category ? (CATEGORY_LABELS[template.category] || template.category) : '-'}
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                -
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                {(() => {
                                                    const supplierId = template.supplier_id
                                                    if (!supplierId) {
                                                        return '-'
                                                    }
                                                    const supplier = suppliers.find(s => s.id === supplierId)
                                                    return supplier?.name ?? `[ספק ${supplierId}]`
                                                })()}
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                מערכת (תבנית)
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">{template.description}</td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">{template.notes || '-'}</td>
                                            <td className="p-3">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => {
                                                            state.setSelectedTemplateForEdit(template)
                                                            state.setEditTemplateModalOpen(true)
                                                        }}
                                                        className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                                                    >
                                                        ערוך
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))
                                ) : state.txs.map((t: Transaction) => {
                                    return (
                                        <tr key={t.id}
                                            className="border-t border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700">
                                            <td className="p-3">
                                                <div className="flex items-center gap-2">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            t.type === 'Income'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300'
                                : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300'
                        }`}>
                          {t.type === 'Income' ? 'הכנסה' : 'הוצאה'}
                            {t.is_exceptional ? ' (חריגה)' : ''}
                        </span>
                                                    {t.is_generated && (
                                                        <span
                                                            className="px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-300"
                                                            title="נוצר אוטומטית מעסקה מחזורית">
                            🔄 מחזורי
                          </span>
                                                    )}
                                                    {t.period_start_date && t.period_end_date && (
                                                        <span
                                                            className="px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-300"
                                                            title="עסקה תאריכית (לפי תאריכים)">
                            📅 תאריכית
                          </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                <div>{t.tx_date}</div>
                                                    {t.period_start_date && t.period_end_date && (
                                                        <div
                                                            className="text-sm text-blue-700 dark:text-blue-400 font-semibold mt-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded"
                                                            key={`dated-dates-${t.id}`}
                                                            dir="ltr">
                                                            תאריכית: {formatDate(t.period_start_date)} – {formatDate(t.period_end_date)}
                                                        </div>
                                                    )}
                                            </td>
                                            <td className={`p-3 font-semibold ${t.type === 'Income' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                <div>
                                                    {Number((t as any).proportionalAmount !== undefined ? (t as any).proportionalAmount : t.amount || 0).toFixed(2)} ₪
                                                    {(t as any).proportionalAmount !== undefined && (t as any).proportionalAmount !== (t as any).fullAmount && (
                                                        <div
                                                            className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                                            מתוך {Number((t as any).fullAmount || 0).toFixed(2)} ₪
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                {t.category ? (CATEGORY_LABELS[t.category] || t.category) : '-'}
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                {t.payment_method ? (PAYMENT_METHOD_LABELS[t.payment_method] || t.payment_method) : '-'}
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                {(() => {
                                                    const supplierId = t.supplier_id
                                                    if (!supplierId) {
                                                        return '-'
                                                    }
                                                    const supplier = suppliers.find(s => s.id === supplierId)
                                                    return supplier?.name ?? `[ספק ${supplierId}]`
                                                })()}
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">
                                                {t.created_by_user ? (
                                                    <div className="flex flex-col">
                                                        <span
                                                            className="font-medium">{t.created_by_user.full_name}</span>
                                                        <span
                                                            className="text-xs text-gray-500 dark:text-gray-400">{t.created_by_user.email}</span>
                                                    </div>
                                                ) : t.is_generated ? (
                                                    <span
                                                        className="text-gray-400 dark:text-gray-500">מערכת (מחזורי)</span>
                                                ) : (
                                                    <span className="text-gray-400 dark:text-gray-500">מערכת</span>
                                                )}
                                            </td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">{t.description ?? '-'}</td>
                                            <td className="p-3 text-gray-700 dark:text-gray-300">{t.notes ?? '-'}</td>
                                            <td className="p-3">
                                                <div className="flex items-center gap-2">
                                                    <button
                                                        onClick={() => handleEditAnyTransaction(t)}
                                                        className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                                                    >
                                                        ערוך
                                                    </button>
                                                    <button
                                                        onClick={() => handleDeleteTransaction(t.id, t)}
                                                        className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                                                    >
                                                        מחק
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            state.setSelectedTransactionForDocuments(t)
                                                            state.setShowDocumentsModal(true)
                                                            state.setDocumentsLoading(true)
                                                            try {
                                                                const {data} = await api.get(`/transactions/${t.id}/documents`)
                                                                state.setTransactionDocuments(data || [])
                                                            } catch (err: any) {
                                                                state.setTransactionDocuments([])
                                                            } finally {
                                                                state.setDocumentsLoading(false)
                                                            }
                                                        }}
                                                        className="px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700"
                                                    >
                                                        מסמכים
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </motion.div>
            )}


            {/* Modals */}
            <CreateTransactionModal
                isOpen={state.showCreateTransactionModal}
                onClose={() => state.setShowCreateTransactionModal(false)}
                onSuccess={async () => {
                    state.setShowCreateTransactionModal(false)
                    // Use loadAllProjectData with viewingPeriodId to maintain historical period filtering
                    await dataLoaders.loadAllProjectData(viewingPeriodId)
                }}
                projectId={parseInt(id || '0')}
                isSubproject={!!state.relationProject}
                projectName={state.projectName}
                projectStartDate={firstContractStartDate || state.projectStartDate}
            />

            <EditTransactionModal
                isOpen={state.editTransactionModalOpen}
                onClose={() => {
                    state.setEditTransactionModalOpen(false)
                    state.setSelectedTransactionForEdit(null)
                }}
                onSuccess={async () => {
                    state.setEditTransactionModalOpen(false)
                    state.setSelectedTransactionForEdit(null)
                    state.setTxs([])
                    // רענון מלא של העמוד וטעינת הנתונים המעודכנים
                    await dataLoaders.loadAllProjectData(viewingPeriodId)
                    await dataLoaders.loadUnforeseenTransactions()
                }}
                transaction={state.selectedTransactionForEdit}
                projectStartDate={firstContractStartDate || state.projectStartDate}
                getAllTransactions={async (): Promise<any[]> => {
                    // Return all transactions for the project (used for deleteAll functionality)
                    return state.txs as any[]
                }}
            />

            <EditRecurringSelectionModal
                isOpen={state.showRecurringSelectionModal}
                onClose={() => {
                    state.setShowRecurringSelectionModal(false)
                    state.setSelectedTransactionForEdit(null)
                }}
                onEditInstance={() => handleEditRecurringSelection('instance')}
                onEditSeries={() => handleEditRecurringSelection('series')}
            />

            <EditRecurringTemplateModal
                isOpen={state.editTemplateModalOpen}
                onClose={() => {
                    state.setEditTemplateModalOpen(false)
                    state.setSelectedTemplateForEdit(null)
                    state.setPendingTemplateLoad(false)
                }}
                onSuccess={async () => {
                    state.setEditTemplateModalOpen(false)
                    state.setSelectedTemplateForEdit(null)
                    // Use loadAllProjectData with viewingPeriodId to maintain historical period filtering
                    await dataLoaders.loadAllProjectData(viewingPeriodId)
                    if (state.transactionTypeFilter === 'recurring') {
                        await dataLoaders.loadRecurringTemplates()
                    }
                }}
                template={state.selectedTemplateForEdit}
            />

            <DeleteTransactionModal
                isOpen={state.showDeleteTransactionModal}
                onClose={() => {
                    state.setShowDeleteTransactionModal(false)
                    state.setTransactionToDelete(null)
                }}
                onConfirm={confirmDeleteTransaction}
                transaction={state.transactionToDelete as any}
                loading={state.isDeletingTransaction}
            />

            <CreateProjectModal
                isOpen={state.showEditProjectModal}
                onClose={() => {
                    state.setShowEditProjectModal(false)
                    state.setEditingProject(null)
                }}
                onSuccess={handleProjectUpdateSuccess}
                editingProject={state.editingProject}
            />

            {/* Documents Modals */}
            <DocumentsModals
                showDocumentsModal={state.showDocumentsModal}
                selectedTransactionForDocuments={state.selectedTransactionForDocuments}
                selectedDocument={state.selectedDocument}
                transactionDocuments={state.transactionDocuments}
                documentsLoading={state.documentsLoading}
                onCloseDocuments={() => {
                    state.setShowDocumentsModal(false)
                    state.setSelectedTransactionForDocuments(null)
                    state.setSelectedDocument(null)
                }}
                onCloseDocumentViewer={() => state.setSelectedDocument(null)}
                onSelectDocument={state.setSelectedDocument}
            />

            {/* Create Budget Modal */}
            <CreateBudgetModal
                isOpen={state.showAddBudgetForm}
                isViewingHistoricalPeriod={isViewingHistoricalPeriod}
                newBudgetForm={state.newBudgetForm}
                budgetDateMode={state.budgetDateMode}
                projectStartDate={state.projectStartDate}
                availableCategories={state.availableCategories}
                projectBudgets={state.projectBudgets}
                budgetFormError={state.budgetFormError}
                budgetSaving={state.budgetSaving}
                onClose={() => {
                    state.setShowAddBudgetForm(false)
                    state.setBudgetFormError(null)
                    state.setBudgetDateMode('today')
                }}
                onFormChange={(form) => state.setNewBudgetForm(form)}
                onDateModeChange={(mode) => state.setBudgetDateMode(mode)}
                onSubmit={handleAddBudget}
            />

            {/* Edit Budget Modal */}
            <EditBudgetModal
                isOpen={state.showEditBudgetForm && !!state.budgetToEdit}
                budgetToEdit={state.budgetToEdit}
                editBudgetForm={state.editBudgetForm}
                availableCategories={state.availableCategories}
                projectBudgets={state.projectBudgets}
                editBudgetError={state.editBudgetError}
                editBudgetSaving={state.editBudgetSaving}
                onClose={() => {
                    if (!state.editBudgetSaving) {
                        state.setShowEditBudgetForm(false)
                        state.setBudgetToEdit(null)
                        state.setEditBudgetError(null)
                    }
                }}
                onFormChange={(form) => state.setEditBudgetForm(form)}
                onSubmit={handleUpdateBudget}
            />

            {/* Description Modal for Uploaded Documents */}
            <DescriptionModal
                isOpen={state.showDescriptionModal && !!state.selectedTransactionForDocuments && state.uploadedDocuments.length > 0}
                selectedTransactionId={state.selectedTransactionForDocuments?.id || 0}
                uploadedDocuments={state.uploadedDocuments}
                onClose={() => {
                    state.setShowDescriptionModal(false)
                    state.setUploadedDocuments([])
                }}
                onDocumentsChange={state.setUploadedDocuments}
                onSave={async () => {
                    await dataLoaders.reloadChartsDataOnly()
                }}
                onReloadDocuments={async () => {
                    if (state.showDocumentsModal && state.selectedTransactionForDocuments?.id) {
                        const {data} = await api.get(`/transactions/${state.selectedTransactionForDocuments.id}/documents`)
                        state.setTransactionDocuments(data || [])
                    }
                }}
            />

            {/* Previous Years Modal */}
            <PreviousYearsModal
                isOpen={state.showPreviousYearsModal}
                loadingPeriodSummary={state.loadingPeriodSummary}
                contractPeriods={state.contractPeriods}
                projectName={state.projectName}
                projectId={id || ''}
                onClose={() => state.setShowPreviousYearsModal(false)}
                onNavigateToPeriod={(periodId) => {
                    state.setShowPreviousYearsModal(false)
                    setSearchParams({period: periodId.toString()})
                }}
            />

            {/* Contract Period Summary Modal */}
            <ContractPeriodSummaryModal
                isOpen={state.showPeriodSummaryModal}
                loadingPeriodSummary={state.loadingPeriodSummary}
                selectedPeriodSummary={state.selectedPeriodSummary}
                projectName={state.projectName}
                projectId={id || ''}
                onClose={() => {
                    state.setShowPeriodSummaryModal(false)
                    state.setSelectedPeriodSummary(null)
                }}
                onShowPreviousYears={() => {
                    state.setShowPeriodSummaryModal(false)
                    state.setSelectedPeriodSummary(null)
                    state.setShowPreviousYearsModal(true)
                }}
                onExportCSV={async () => {
                    if (!state.selectedPeriodSummary) return
                    try {
                        const response = await api.get(
                            `/projects/${id}/contract-periods/${state.selectedPeriodSummary.period_id}/export-csv`,
                            {responseType: 'blob'}
                        )
                        const url = window.URL.createObjectURL(new Blob([response.data]))
                        const link = document.createElement('a')
                        link.href = url
                        link.setAttribute('download', `contract_period_${state.selectedPeriodSummary.year_label || `שנת_${state.selectedPeriodSummary.contract_year}`}_${state.projectName}.csv`)
                        document.body.appendChild(link)
                        link.click()
                        link.remove()
                        window.URL.revokeObjectURL(url)
                    } catch (err) {
                        console.error('Error exporting CSV:', err)
                        alert('שגיאה בייצוא CSV')
                    }
                }}
            />

            <ContractViewerModal
                isOpen={state.showContractModal}
                contractFileUrl={state.contractFileUrl}
                contractViewerUrl={contractViewerUrl}
                onClose={() => state.setShowContractModal(false)}
            />

            {/* Monthly Expense Table */}
            <MonthlyExpenseTable
                transactions={state.txs}
                projectStartDate={state.projectStartDate}
                projectBudget={state.projectBudget}
                monthlyTableYear={state.monthlyTableYear}
                isViewingHistoricalPeriod={isViewingHistoricalPeriod}
                selectedPeriod={state.selectedPeriod}
                globalDateFilterMode={state.globalDateFilterMode}
                globalSelectedMonth={state.globalSelectedMonth}
                globalStartDate={state.globalStartDate}
                globalEndDate={state.globalEndDate}
                firstContractStartDate={firstContractStartDate}
                suppliers={suppliers}
                onYearChange={state.setMonthlyTableYear}
                onShowTransactionDetails={async (tx) => {
                    if ((tx as any).is_unforeseen) {
                        try {
                            const fresh = await UnforeseenTransactionAPI.getUnforeseenTransactionByResultingTransactionId(tx.id)
                            state.setSelectedUnforeseenTransactionForDetails(fresh as any)
                            state.setUnforeseenDetailsReadOnly(true)
                            state.setShowUnforeseenTransactionDetailsModal(true)
                        } catch (_) {
                            alert('לא נמצאה עסקה לא צפויה מקושרת')
                        }
                    } else {
                        state.setSelectedTransactionForDetails(tx)
                        state.setShowTransactionDetailsModal(true)
                    }
                }}
                onShowDocumentsModal={async (tx) => {
                    state.setSelectedTransactionForDocuments(tx)
                    state.setShowDocumentsModal(true)
                    state.setDocumentsLoading(true)
                    try {
                        const {data} = await api.get(`/transactions/${tx.id}/documents`)
                        state.setTransactionDocuments(data || [])
                    } catch (err) {
                        state.setTransactionDocuments([])
                    } finally {
                        state.setDocumentsLoading(false)
                    }
                }}
                onEditTransaction={handleEditAnyTransaction}
            />

            {/* Archive/Delete Choice Modal */}
            <ArchiveDeleteModal
                isOpen={state.showArchiveDeleteModal}
                projectName={state.projectName}
                onClose={() => state.setShowArchiveDeleteModal(false)}
                onArchive={handleArchive}
                onDelete={handleDeleteChoice}
            />

            {/* Unforeseen Transactions Modal */}
            <UnforeseenTransactionsModal
                isOpen={state.showUnforeseenTransactionsModal}
                unforeseenTransactions={state.unforeseenTransactions as any}
                unforeseenTransactionsFilter={state.unforeseenTransactionsFilter}
                onClose={() => {
                    state.setShowUnforeseenTransactionsModal(false)
                    state.setUnforeseenTransactionsFilter('all')
                }}
                onFilterChange={state.setUnforeseenTransactionsFilter}
                onExecuteTransaction={async (txId) => {
                    try {
                        await UnforeseenTransactionAPI.executeUnforeseenTransaction(txId)
                        await dataLoaders.loadUnforeseenTransactions()
                        await dataLoaders.loadTransactionsOnly()
                    } catch (err: any) {
                        alert(err.response?.data?.detail || 'שגיאה בביצוע העסקה')
                    }
                }}
                onDeleteTransaction={async (txId) => {
                    try {
                        await UnforeseenTransactionAPI.deleteUnforeseenTransaction(txId)
                        await dataLoaders.loadUnforeseenTransactions()
                        // Reload regular transactions in case an executed transaction was deleted
                        await dataLoaders.loadTransactionsOnly()
                    } catch (err: any) {
                        alert(err.response?.data?.detail || 'שגיאה במחיקת העסקה')
                    }
                }}
                onViewDetails={async (tx) => {
                    state.setUnforeseenDetailsReadOnly(false)
                    try {
                        const fresh = await UnforeseenTransactionAPI.getUnforeseenTransaction(tx.id)
                        state.setSelectedUnforeseenTransactionForDetails(fresh as any)
                    } catch (_) {
                        state.setSelectedUnforeseenTransactionForDetails(tx as any)
                    }
                    state.setShowUnforeseenTransactionsModal(false)
                    state.setShowUnforeseenTransactionDetailsModal(true)
                }}
                onEditTransaction={async (tx) => {
                    state.setShowUnforeseenTransactionsModal(false)
                    try {
                        const fresh = await UnforeseenTransactionAPI.getUnforeseenTransaction(tx.id)
                        // @ts-ignore - Type mismatch between local interface and API type
                        state.setEditingUnforeseenTransaction(fresh as any)
                        state.setUnforeseenDescription(fresh.description || '')
                        state.setUnforeseenNotes(fresh.notes || '')
                        state.setUnforeseenTransactionDate(fresh.transaction_date)
                        state.setUnforeseenIncomes(
                            fresh.incomes && fresh.incomes.length > 0
                                ? fresh.incomes.map((inc: any) => ({
                                    amount: inc.amount,
                                    description: inc.description || '',
                                    incomeId: inc.id,
                                    documentFiles: [],
                                    documentIds: inc.documents ? inc.documents.map((d: any) => d.id) : []
                                }))
                                : (fresh as any).income_amount > 0
                                    ? [{ amount: (fresh as any).income_amount, description: (fresh as any).description || 'הכנסה', documentFiles: [], incomeId: null, documentIds: [] }]
                                    : [{ amount: 0, description: '', documentFiles: [], incomeId: null, documentIds: [] }]
                        )
                        state.setUnforeseenExpenses(
                            fresh.expenses && fresh.expenses.length > 0
                                ? fresh.expenses.map((exp: any) => ({
                                    amount: exp.amount,
                                    description: exp.description || '',
                                    documentIds: exp.documents ? exp.documents.map((d: any) => d.id) : [],
                                    expenseId: exp.id,
                                    documentFiles: []
                                }))
                                : [{ amount: 0, description: '', documentFiles: [], expenseId: null, documentIds: [] }]
                        )
                        state.setShowCreateUnforeseenTransactionModal(true)
                    } catch (_) {
                        const txAny = tx as any
                        state.setEditingUnforeseenTransaction(txAny)
                        state.setUnforeseenDescription(tx.description || '')
                        state.setUnforeseenNotes(tx.notes || '')
                        state.setUnforeseenTransactionDate(tx.transaction_date)
                        state.setUnforeseenIncomes(
                            txAny.incomes && txAny.incomes.length > 0
                                ? txAny.incomes.map((inc: any) => ({
                                    amount: inc.amount,
                                    description: inc.description || '',
                                    incomeId: inc.id,
                                    documentFiles: [],
                                    documentIds: inc.documents ? inc.documents.map((d: any) => d.id) : []
                                }))
                                : txAny.income_amount > 0
                                    ? [{ amount: txAny.income_amount, description: txAny.description || 'הכנסה', documentFiles: [], incomeId: null, documentIds: [] }]
                                    : [{ amount: 0, description: '', documentFiles: [], incomeId: null, documentIds: [] }]
                        )
                        state.setUnforeseenExpenses(
                            txAny.expenses && txAny.expenses.length > 0
                                ? txAny.expenses.map((exp: any) => ({
                                    amount: exp.amount,
                                    description: exp.description || '',
                                    documentIds: exp.documents ? exp.documents.map((d: any) => d.id) : [],
                                    expenseId: exp.id,
                                    documentFiles: []
                                }))
                                : [{ amount: 0, description: '', documentFiles: [], expenseId: null, documentIds: [] }]
                        )
                        state.setShowCreateUnforeseenTransactionModal(true)
                    }
                }}
                onCreateNew={() => {
                    state.setShowUnforeseenTransactionsModal(false)
                    try { resetUnforeseenForm() } catch (_) { /* ensure create modal opens */ }
                    state.setShowCreateUnforeseenTransactionModal(true)
                }}
                onUpdateStatus={async (txId, status) => {
                    try {
                        await UnforeseenTransactionAPI.updateUnforeseenTransaction(txId, { status })
                        await dataLoaders.loadUnforeseenTransactions()
                        await dataLoaders.loadAllProjectData(viewingPeriodId)
                    } catch (err: any) {
                        alert(err.response?.data?.detail || 'שגיאה בעדכון הסטטוס')
                    }
                }}
            />

            {/* Create/Edit Unforeseen Transaction Modal */}
            <CreateUnforeseenTransactionModal
                isOpen={state.showCreateUnforeseenTransactionModal}
                editingUnforeseenTransaction={state.editingUnforeseenTransaction as any}
                unforeseenIncomes={state.unforeseenIncomes as any}
                unforeseenDescription={state.unforeseenDescription}
                unforeseenNotes={state.unforeseenNotes}
                unforeseenTransactionDate={state.unforeseenTransactionDate}
                unforeseenExpenses={state.unforeseenExpenses as any}
                unforeseenSubmitting={state.unforeseenSubmitting}
                uploadingDocumentForExpense={state.uploadingDocumentForExpense}
                uploadingDocumentForIncome={state.uploadingDocumentForIncome}
                onClose={() => {
                    state.setShowCreateUnforeseenTransactionModal(false)
                    resetUnforeseenForm()
                }}
                onAddIncome={handlers.handleAddUnforeseenIncome}
                onRemoveIncome={handlers.handleRemoveUnforeseenIncome}
                onIncomeChange={handlers.handleUnforeseenIncomeChange}
                onIncomeDocumentChange={handleUnforeseenIncomeDocumentChange}
                onRemoveIncomeDocument={handleRemoveUnforeseenIncomeDocument}
                onDescriptionChange={state.setUnforeseenDescription}
                onNotesChange={state.setUnforeseenNotes}
                onTransactionDateChange={state.setUnforeseenTransactionDate}
                onAddExpense={handleAddUnforeseenExpense}
                onRemoveExpense={handleRemoveUnforeseenExpense}
                onExpenseChange={handleUnforeseenExpenseChange}
                onExpenseDocumentChange={handleUnforeseenExpenseDocumentChange}
                onRemoveExpenseDocument={handleRemoveUnforeseenExpenseDocument}
                onSaveAsDraft={() => state.editingUnforeseenTransaction ? handleUpdateUnforeseenTransaction('draft') : handleCreateUnforeseenTransaction('draft')}
                onSaveAsWaitingForApproval={() => state.editingUnforeseenTransaction ? handleUpdateUnforeseenTransaction('waiting_for_approval') : handleCreateUnforeseenTransaction('waiting_for_approval')}
                onSaveAndExecute={handleCreateAndExecuteUnforeseenTransaction}
                onUpdate={() => handleUpdateUnforeseenTransaction()}
                onDelete={async () => {
                    if (!confirm('האם אתה בטוח שברצונך למחוק עסקה זו? זה ימחק גם את העסקה הרגילה שנוצרה בפרויקט.')) {
                        return
                    }
                    try {
                        state.setUnforeseenSubmitting(true)
                        await UnforeseenTransactionAPI.deleteUnforeseenTransaction(state.editingUnforeseenTransaction?.id || 0)
                        state.setShowCreateUnforeseenTransactionModal(false)
                        resetUnforeseenForm()
                        await dataLoaders.loadUnforeseenTransactions()
                        await dataLoaders.loadAllProjectData(viewingPeriodId)
                    } catch (err: any) {
                        alert(err.response?.data?.detail || 'שגיאה במחיקת העסקה')
                    } finally {
                        state.setUnforeseenSubmitting(false)
                    }
                }}
                onExecute={async () => {
                    try {
                        state.setUnforeseenSubmitting(true)
                        await UnforeseenTransactionAPI.executeUnforeseenTransaction(state.editingUnforeseenTransaction?.id || 0)
                        state.setShowCreateUnforeseenTransactionModal(false)
                        resetUnforeseenForm()
                        await dataLoaders.loadUnforeseenTransactions()
                        await dataLoaders.loadAllProjectData(viewingPeriodId)
                    } catch (err: any) {
                        alert(err.response?.data?.detail || 'שגיאה בביצוע העסקה')
                    } finally {
                        state.setUnforeseenSubmitting(false)
                    }
                }}
                calculateTotalExpenses={calculateUnforeseenTotalExpenses}
                calculateProfitLoss={calculateUnforeseenProfitLoss}
            />

            {/* Delete Confirmation Modal with Password */}
            <DeleteConfirmModal
                isOpen={state.showDeleteConfirmModal}
                projectName={state.projectName}
                deletePassword={state.deletePassword}
                deletePasswordError={state.deletePasswordError}
                isDeleting={state.isDeleting}
                onClose={() => {
                    state.setShowDeleteConfirmModal(false)
                    state.setDeletePassword('')
                    state.setDeletePasswordError('')
                }}
                onPasswordChange={(password) => {
                    state.setDeletePassword(password)
                    state.setDeletePasswordError('')
                }}
                onConfirm={handleDeleteConfirm}
            />

            {/* Unforeseen Transaction Details Modal */}
            <UnforeseenTransactionDetailsModal
                isOpen={state.showUnforeseenTransactionDetailsModal}
                transaction={state.selectedUnforeseenTransactionForDetails}
                readOnly={state.unforeseenDetailsReadOnly}
                onClose={() => {
                    state.setShowUnforeseenTransactionDetailsModal(false)
                    state.setSelectedUnforeseenTransactionForDetails(null)
                    state.setUnforeseenDetailsReadOnly(false)
                }}
                onEdit={async (tx) => {
                    state.setShowUnforeseenTransactionDetailsModal(false)
                    try {
                        const fresh = await UnforeseenTransactionAPI.getUnforeseenTransaction(tx.id)
                        // @ts-ignore - Type mismatch between local interface and API type
                        state.setEditingUnforeseenTransaction(fresh as any)
                        state.setUnforeseenDescription(fresh.description || '')
                        state.setUnforeseenNotes(fresh.notes || '')
                        state.setUnforeseenTransactionDate(fresh.transaction_date)
                        state.setUnforeseenIncomes(
                            fresh.incomes && fresh.incomes.length > 0
                                ? fresh.incomes.map((inc: any) => ({
                                    amount: inc.amount,
                                    description: inc.description || '',
                                    incomeId: inc.id,
                                    documentFiles: [],
                                    documentIds: inc.documents ? inc.documents.map((d: any) => d.id) : []
                                }))
                                : (fresh as any).income_amount > 0
                                    ? [{ amount: (fresh as any).income_amount, description: '', documentFiles: [], incomeId: null, documentIds: [] }]
                                    : [{ amount: 0, description: '', documentFiles: [], incomeId: null, documentIds: [] }]
                        )
                        state.setUnforeseenExpenses(
                            fresh.expenses && fresh.expenses.length > 0
                                ? fresh.expenses.map((exp: any) => ({
                                    amount: exp.amount,
                                    description: exp.description || '',
                                    documentIds: exp.documents ? exp.documents.map((d: any) => d.id) : [],
                                    expenseId: exp.id,
                                    documentFiles: []
                                }))
                                : [{ amount: 0, description: '', documentFiles: [], expenseId: null, documentIds: [] }]
                        )
                        state.setShowCreateUnforeseenTransactionModal(true)
                    } catch (e) {
                        // @ts-ignore
                        state.setEditingUnforeseenTransaction(tx as any)
                        state.setUnforeseenIncomes(
                            tx.incomes && tx.incomes.length > 0
                                ? tx.incomes.map((inc: any) => ({
                                    amount: inc.amount,
                                    description: inc.description || '',
                                    incomeId: inc.id,
                                    documentFiles: [],
                                    documentIds: inc.documents ? inc.documents.map((d: any) => d.id) : []
                                }))
                                : [{ amount: tx.income_amount ?? 0, description: '', documentFiles: [], incomeId: null, documentIds: [] }]
                        )
                        state.setUnforeseenDescription(tx.description || '')
                        state.setUnforeseenNotes(tx.notes || '')
                        state.setUnforeseenTransactionDate(tx.transaction_date)
                        state.setUnforeseenExpenses(
                            tx.expenses && tx.expenses.length > 0
                                ? tx.expenses.map((exp: any) => ({
                                    amount: exp.amount,
                                    description: exp.description || '',
                                    documentIds: exp.documents ? exp.documents.map((d: any) => d.id) : [],
                                    expenseId: exp.id,
                                    documentFiles: []
                                }))
                                : [{ amount: 0, description: '', documentFiles: [], expenseId: null, documentIds: [] }]
                        )
                        state.setShowCreateUnforeseenTransactionModal(true)
                    }
                }}
                onDelete={async (txId) => {
                    try {
                        await UnforeseenTransactionAPI.deleteUnforeseenTransaction(txId)
                        await dataLoaders.loadUnforeseenTransactions()
                        await dataLoaders.loadAllProjectData(viewingPeriodId)
                    } catch (err: any) {
                        alert(err.response?.data?.detail || 'שגיאה במחיקת העסקה')
                    }
                }}
                onStatusChange={async () => {
                    await dataLoaders.loadUnforeseenTransactions()
                    await dataLoaders.loadAllProjectData(viewingPeriodId)
                }}
            />
        </div>
    )
}