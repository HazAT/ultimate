export function switchScope(projectSetupChosen: boolean, chosen?: 'project' | 'user') {
  const useProjectSettings = projectSetupChosen && chosen === 'project'
  return useProjectSettings ? 'project' : 'user'
}
