export type ReviewComment = {
  file: string
  side: 'old' | 'new'
  start: number
  end: number
  excerpt: string
  text: string
}

export type ReviewComments = { spec: string; comments: ReviewComment[]; note?: string }
