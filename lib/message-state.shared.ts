type Status = { reply: boolean; state: string; to: number | 'user' | 'remote' }

export const isOpen = (message: Status) =>
  message.reply && (message.state === 'sent' || message.state === 'delivered')

export const isOwed = (message: Status) => message.reply && message.state === 'delivered'

export const openQuestion = (message: Status) => message.to === 'user' && isOwed(message)
