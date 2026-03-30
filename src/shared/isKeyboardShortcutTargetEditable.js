function getTargetElement(target) {
  return target instanceof Element ? target : null
}

export function isKeyboardShortcutTargetEditable(target) {
  const element = getTargetElement(target)
  if (!element) return false
  if (element.closest('[contenteditable="true"]')) return true

  const tagName = element.tagName
  return (
    tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || tagName === 'SELECT'
    || tagName === 'OPTION'
  )
}
