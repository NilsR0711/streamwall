import * as jsondiffpatch from 'jsondiffpatch'

export const stateDiff = jsondiffpatch.create({
  objectHash: (obj, idx) => (obj as { _id?: string })._id || `$$index:${idx}`,
  omitRemovedValues: true,
})
