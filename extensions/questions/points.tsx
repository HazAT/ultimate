import type { ReactNode } from 'react'
import { definePoint } from '@/sdk'
import type { Message } from './open.tsx'

export const CardActions = definePoint<Message, ReactNode>('questions.card-actions')
